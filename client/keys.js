/********************************/
/*        Key Management        */
/********************************/

// This key management is based on Warp Wallet by keybase.io
// https://keybase.io/warp/warp_1.0.9_SHA256_a2067491ab582bde779f4505055807c2479354633a2216b22cf1e92d1a6e4a87.html
// It uses email and password to generate a seed for private keys.
// Using login credentials should enable users to handle keys in a more familiar fashion.

// As an enhancement we use ~60 seconds of argon2d instead of scrypt.
// It makes brute forcing thru dictionary attacks harder than the old warp wallet while keeping the wait time low.
// This is achieved by encrypting and storing the seed locally after first login.
// So the ~60 seconds of Argon2d have to be performed only once per device.

// Another flaw of the old warp wallet was that you had no proof that you entered the correct email + password
// This is solved by storing a hash of our seed to verify if we've used the correct credentials for decryption.

async function login(email, password) {

    const seed = await generateSeed(email, password)
    const keyPair = bitcoin.ECPair.fromPrivateKey(bitcoin.Buffer.from(seed, 'hex'))

    // Derive our address from our public key
    const { address, output } = bitcoin.payments.p2wpkh({
        pubkey: keyPair.publicKey,
        network: NETWORK
    });

    return { address, output, keyPair }
}

async function generateSeed(email, password) {
    // Generate key for encryption / decryption
    const encryptionKey = await generateEncryptionKey(email, password)

    // Try to load an existing encrypted seed 
    let encrypted = localStorage.getItem('encrypted_seed_' + email)

    // If a seed exists return it 
    if (encrypted) {
        const seed = decryptSeed(encrypted, encryptionKey)

        // Use the stored tag to check if the entered password was correct
        const tag = await hashFn(seed, encryptionKey)
        const storedTag = localStorage.getItem('encrypted_seed_tag_' + email)

        if (tag !== storedTag) throw `Invalid Password`;

        return seed
    }

    // Otherwise, generate a new seed
    const seed = await _generateSeed(email, password)
    // Encrypt it
    encrypted = encryptSeed(seed, encryptionKey)
    // Store it
    localStorage.setItem('encrypted_seed_' + email, encrypted)
    // Create a "tag" for us to be able to verify the correct decryption
    const tag = await hashFn(seed, encryptionKey)
    localStorage.setItem('encrypted_seed_tag_' + email, tag)
    // Return it
    return seed
}

async function hashFn(email, password) {
    return (await argon2({ pass: email, salt: password, hashLen: 32 }))
}

async function _generateSeed(email, password) {
    const hash = await argon2({ pass: password, salt: email, time: HASH_ROUNDS_SIGNUP, hashLen: 32 })
    return hash
}


async function generateEncryptionKey(email, password) {
    const hash = await argon2({ pass: password, salt: email, time: HASH_ROUNDS_LOGIN, hashLen: 32 })
    return hash
}

const power2_256 = 2n ** 256n
function encryptSeed(seed, secret) {
    secret = BigInt(`0x${secret}`)
    seed = BigInt(`0x${seed}`)
    const xor = (secret + seed) % power2_256
    return xor.toString(16).padStart(64, '0')
}

function decryptSeed(encrypted, secret) {
    encrypted = BigInt(`0x${encrypted}`)
    secret = BigInt(`0x${secret}`)
    const xor = (power2_256 + encrypted - secret) % power2_256
    return xor.toString(16).padStart(64, '0')
}

function logout() {
    localStorage.setItem('encrypted_seed_', '')
}