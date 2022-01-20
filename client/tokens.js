// Set the network Esplora should use
if (NETWORK == bitcoin.networks.testnet) Esplora.useTestnet()


/********************************/
/*    Token Value Encoding      */
/********************************/

function encodeTokenValue(value) {
    const data = new bitcoin.Buffer(4);
    data.writeUInt32BE(value)
    return bitcoin.payments.embed({ data: [data] }).output
}

function decodeTokenValue(tx) {
    const hexValue = tx.vout[2].scriptpubkey.replace(/^6a04/, '')
    return Number.parseInt(hexValue, 16)
}


/********************************/
/*          Send Tokens         */
/********************************/

async function addAllMyInputs(psbt, myAccount) {
    const utxos = await Esplora.fetchUnspentOutputs(myAccount.address)
    let inputsSum = 0
    utxos.forEach(utxo => {
        // TODO: Check if this utxo is currently used for an open offer

        psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: { script: myAccount.output, value: utxo.value }
        })
        inputsSum += utxo.value
    })
    return inputsSum
}

async function createTokenTransaction(recipientAddress, tokenValue, myAccount, bitcoinValue = 0) {
    // Convert token value to an integer. From USD to cents 
    tokenValue = Math.floor(Number(tokenValue) * 100)

    // Convert bitcoin value to number
    bitcoinValue = Number(bitcoinValue)

    // Ensure we have enough tokens to pay for this transaction
    const tokenBalance = await fetchTokenBalance(myAccount.address)

    if (tokenValue > tokenBalance)
        throw 'Insufficient Dollar funds'

    // Create a blank transaction
    const psbt = new bitcoin.Psbt({ network: NETWORK })

    // We prefere having only a single output.
    // Thus we add all our utxos to this transaction
    const myBitcoinInputsSum = await addAllMyInputs(psbt, myAccount)

    // Calculate the fee
    const fee = MIN_FEE + 68 * (psbt.inputCount - 1)

    // How many bitcoins do we want to give to the recipient?
    const theirBitcoinValue = bitcoinValue || MIN_OUTPUT_VALUE

    // Ensure we have enough bitcoins
    if (myBitcoinInputsSum < theirBitcoinValue + fee)
        throw 'Insufficient Bitcoin funds'

    // Add the recipient's output 
    psbt.addOutput({
        address: recipientAddress,
        value: theirBitcoinValue,
    })

    // Calculate our change value
    const myChangeValue = myBitcoinInputsSum - theirBitcoinValue - fee

    // Check if we need to add a change output
    // TODO

    // Add our change output
    psbt.addOutput({
        address: myAccount.address,
        value: myChangeValue,
    })

    // Data field output
    psbt.addOutput({
        script: encodeTokenValue(tokenValue),
        value: 0,
    })

    // Sign all the inputs
    psbt.signAllInputs(myAccount.keyPair)

    // Finalize all inputs
    psbt.finalizeAllInputs()

    // Return hex encoded transaction to broadcast
    return psbt.extractTransaction().toHex()
}




/********************************/
/*       Receive Tokens         */
/********************************/


// Cached version of _computeTokenValue
async function computeTokenValue(txid, vout) {
    // Check if the token value is already in our cache
    const db_key = txid + '_' + vout
    let value = localStorage.getItem(db_key)
    if (value !== null && value !== undefined)
        return Number(value);

    // Otherwise, compute token value and cache it
    value = await _computeTokenValue(txid, vout)
    localStorage.setItem(db_key, value)
    return value
}

async function _computeTokenValue(txid, vout) {
    const tx = await Esplora.fetchTransaction(txid)

    // Has the transaction the correct format?
    if (!isTokenTransactionFormat(tx))
        return 0;

    // Read recipient token value
    const recipientTokenValue = decodeTokenValue(tx)

    // The recursion's base case is a genesis transaction 
    if (isTokenGenesis(tx) && vout === 0)
        return recipientTokenValue;

    // Iterate over all inputs and recurse
    let sumInputs = 0
    for (let i = 0; i < tx.vin.length; i++) {
        const vin = tx.vin[i]
        const inValue = await computeTokenValue(vin.txid, vin.vout)
        sumInputs += inValue
    }

    // Are there enough input tokens? 
    if (sumInputs < recipientTokenValue)
        return 0;

    // Return token value of the output corresponding to vout
    switch (vout) {
        case 0:
            return recipientTokenValue;
        case 1:
            return sumInputs - recipientTokenValue;
        default:
            return 0;
    }
}

function isTokenTransactionFormat(tx) {
    // Check if there are exactly 3 outputs
    if (tx.vout.length !== 3) return false;

    // Check if third output is an OP_RETURN followed by OP_PUSH(4)
    return tx.vout[2].scriptpubkey.startsWith('6a04')
}


function isTokenGenesis(tx) {
    // Check if the sender is the genesis address
    const prevAddress = tx.vin[0].prevout.scriptpubkey_address
    return prevAddress === TOKEN_GENESIS_ADDRESS
}

async function fetchUnspentTokenOutputs(myAddress) {
    // Fetch all our outputs
    const unspentOutputs = await Esplora.fetchUnspentOutputs(myAddress)
    // Filter out all outputs that carry no tokens
    const unspentTokenOutputs = []
    for (let i = 0; i < unspentOutputs.length; i++) {
        const unspentOutput = unspentOutputs[i]
        const txid = unspentOutput.txid
        const vout = unspentOutput.vout

        const tokenValue = await computeTokenValue(txid, vout)

        if (!tokenValue) continue;

        unspentOutput.tokenValue = tokenValue
        unspentTokenOutputs.push(unspentOutput)
    }
    // Return list of token outputs
    return unspentTokenOutputs
}

async function fetchTokenBalance(myAddress) {
    // Fetch all token outputs
    const utxos = await fetchUnspentTokenOutputs(myAddress)
    // Sum up all token values
    return utxos.reduce((akku, utxo) => akku + Number(utxo.tokenValue), 0)
}

/********************************/
/*          Trading             */
/********************************/


function idToHash(txid) {
    return bitcoin.Buffer.from(txid, 'hex').reverse();
}

function hashToId(hash) {
    return hash.reverse().toString('hex')
}

async function createOffer(offeredTokenValue, demandedBitcoinValue, myAccount) {

    // Check if we have an output that matches the offeredTokenValue
    const utxos = await fetchUnspentTokenOutputs(myAccount.address)
    for (let i = 0; i < utxos.length; i++) {
        const utxo = utxos[i];

        // If the value is not equal we stop and continue with the next output
        if (utxo.tokenValue !== offeredTokenValue * 100) continue;

        // Build the swap transaction (spending the utxo)
        return createSwapTx(utxo.txid, utxo.vout, utxo.value, demandedBitcoinValue, myAccount)
    }

    // Otherwise, build a split transaction 
    // to create an output with the amount of tokens that we want to sell
    const splitTx = await createTokenTransaction(myAccount.address, offeredTokenValue, myAccount)
    // Broadcast the split transaction
    const txid = await Esplora.broadcastTransaction(splitTx)
    // We sell the first output of the split TX
    const vout = 0

    // Build the swap transaction (spending the split transaction's output)
    const swapTx = createSwapTx(txid, vout, MIN_OUTPUT_VALUE, demandedBitcoinValue, myAccount)

    return swapTx
}


function createSwapTx(txid, vout, inputBitcoinValue, demandedBitcoinValue, myAccount) {

    // Ensure demandedBitcoinValue is an integer
    if (!Number.isInteger(demandedBitcoinValue))
        throw 'Demanded Bitcoin value is not an integer.';

    const psbt = new bitcoin.Psbt({ network: NETWORK })
    const hashType = bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY

    // Add our token input
    psbt.addInput({
        hash: txid,
        index: vout,
        witnessUtxo: {
            script: myAccount.output,
            value: inputBitcoinValue,
        },
        sighashType: hashType
    })

    // Add our output
    psbt.addOutput({
        address: myAccount.address,
        value: demandedBitcoinValue + inputBitcoinValue, // what we want + what we already have
    })

    // Sign and finalize our input and output
    psbt.signInput(0, myAccount.keyPair, [hashType])
    psbt.finalizeAllInputs()

    const offer = psbt.toBase64()
    return { offer, txid }
}


async function parseOffer(offer) {
    // Parse base64 encoded offer psbt
    const psbt = bitcoin.Psbt.fromBase64(offer, { network: NETWORK })

    // Ensure the offer has exactly one input and one output 
    if (psbt.inputCount !== 1 || psbt.txOutputs.length !== 1)
        throw 'Invalid offer! It should have exactly one input and one output.';

    // Get the offer's outpoint
    const theirTxid = hashToId(psbt.txInputs[0].hash)
    const theirVout = psbt.txInputs[0].index

    // Ensure the offer is unspent
    const outspends = await Esplora.fetchTransactionOutspends(theirTxid)
    if (outspends[theirVout].spent)
        throw 'Offer is already spent'

    // Get the offer's bitcoin input value in sats
    const theirTx = await Esplora.fetchTransaction(theirTxid)
    const theirBitcoinInputValue = theirTx.vout[theirVout].value

    // Get the creator of the offer
    const theirAddress = theirTx.vout[theirVout].scriptpubkey_address

    // Get the offer's bitcoin output value in sats
    const theirBitcoinOutputValue = psbt.txOutputs[0].value

    // Get the demanded bitcoin value in sats
    const theirDemandedBitcoinValue = theirBitcoinOutputValue - theirBitcoinInputValue

    // Get the offer's token value in cents
    const theirTokenValue = await computeTokenValue(theirTxid, theirVout)

    // Offers with a token value of zero are invalid.
    if (theirTokenValue == 0)
        throw 'Invalid offer! The Dollar value is zero.';

    // Compute the exchange rate in cents/BTC
    const exchangeRate = Math.floor(theirTokenValue / theirDemandedBitcoinValue * 1e6) * 100

    return {
        psbt,
        theirTokenValue,
        theirDemandedBitcoinValue,
        exchangeRate,
        theirOutpoint: {
            txid: theirTxid,
            vout: theirVout,
            address: theirAddress
        }
    }
}

async function acceptOffer(swapOffer, myAccount) {
    // Parse and deconstruct the offer 
    const {
        psbt,
        theirTokenValue,
        theirDemandedBitcoinValue,
        exchangeRate
    } = await parseOffer(swapOffer)

    // Let the user confirm the trade
    if (!confirm(`Do you want to sell ${formatBTC(theirDemandedBitcoinValue)} for ${formatUSD(theirTokenValue)} at a price of ${formatUSD(exchangeRate)} per bitcoin?`))
        return;

    // Add all our inputs
    const myBitcoinInputValue = await addAllMyInputs(psbt, myAccount)

    // Calculate fee
    const fee = MIN_FEE + 68 * (psbt.inputCount - 1)

    // Calculate our change value 
    const myChangeValue = myBitcoinInputValue - theirDemandedBitcoinValue - fee

    // Check if we have enough bitcoins
    if (myChangeValue < MIN_OUTPUT_VALUE)
        throw `You need more bitcoins to accept this offer.`;

    // Add our token output (which is also our bitcoin change output)
    psbt.addOutput({
        address: myAccount.address,
        value: myChangeValue,
    })

    // Add a data output to encode the token value.
    // tokenValue == 0 encodes that all input tokens go to the second output,
    // both their input tokens and also our input tokens!
    psbt.addOutput({
        script: encodeTokenValue(0),
        value: 0,
    })

    // Sign our inputs
    for (let i = 1; i < psbt.inputCount; i++) {
        psbt.signInput(i, myAccount.keyPair)
        psbt.finalizeInput(i)
    }

    // Return hex encoded PSBT
    return psbt.extractTransaction().toHex()
}