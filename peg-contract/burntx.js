const utxo = {
    txid:'4b6475c2934cbee9fcd0dce9724fb9897186c0f1f98ea286e940c6690d94d066',
    vout: 0,
    value: 295,
    ethereumAddress: '5B38Da6a701c568545dCfcB03FcB875f56beddC4'
}

const psbt = new bitcoin.Psbt({ network: NETWORK })

const fromHexString = hexString =>
  new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

psbt.addInput({
    hash: utxo.txid,
    index: utxo.vout,
    witnessUtxo: { script: MY_ACCOUNT.output, value: utxo.value }
})
// Data field output
psbt.addOutput({
    script: encodeEthereumAddress(utxo.ethereumAddress),
    value: 0,
})


function encodeEthereumAddress(address) {
    const data = bitcoin.Buffer.from(address,'hex');
    return bitcoin.payments.embed({ data: [data] }).output
}


// Sign all the inputs
psbt.signAllInputs(MY_ACCOUNT.keyPair)

// Finalize all inputs
psbt.finalizeAllInputs()

// Return hex encoded transaction to broadcast
psbt.extractTransaction().toHex()



// d18de04677a73a455285fc17f58fc944c62632445770610f8e978d9a9028c70a


// genesis: 4b6475c2934cbee9fcd0dce9724fb9897186c0f1f98ea286e940c6690d94d066:1
// split: 2d7ee75aef086f63c5b1472246d3c191050979a9730c8274aac3baadaf6b5fce:0
// burn: fb3aa01d75ed37ee0c7938f28618a1ef1fd537124dc6e8f903edf15f022035c2