import { WebSocketServer } from 'ws';
import * as bitcoin from 'bitcoinjs-lib';
import * as Esplora from './esplora.js';



const wss = new WebSocketServer({ port: process.env.PORT || 3000 })
const MAX_MSG_SIZE = 500

const NETWORK = bitcoin.networks.mainnet

if (NETWORK === bitcoin.networks.testnet)
    Esplora.useTestnet()

let orderbook = []

function hashToId(hash) {
    return hash.reverse().toString('hex')
}

async function onMessage(msg, ws) {
    if (msg.toString() == 'heartbeat')
        return;
    try {
        if (msg.size > MAX_MSG_SIZE) return;

        // Parse base64 encoded offer psbt
        const psbt = bitcoin.Psbt.fromBase64(msg, { network: NETWORK })

        // Ensure the offer has exactly one input and one output 
        if (psbt.inputCount !== 1 || psbt.txOutputs.length !== 1)
            throw 'Invalid offer! It should have exactly one input and one output.';


        // Get the offer's outpoint
        const theirTxid = hashToId(psbt.txInputs[0].hash)
        const theirVout = psbt.txInputs[0].index

        // Check if it is unspent
        const outspends = await Esplora.fetchTransactionOutspends(theirTxid)

        if (outspends[theirVout].spent)
            throw 'Outpoint already spent'

        // Store the offer
        orderbook.push(msg)

        orderbook = await cleanOrderbook(orderbook)
        // broadcast message
        wss.clients.forEach(client => {
             client.send(JSON.stringify(orderbook))
        })
    } catch (e) {
        console.error(e)
    }
}

async function cleanOrderbook(orderbook) {

    const ordersMap = {}
    for (let i = 0; i < orderbook.length; i++) {
        const order = orderbook[i]

        const psbt = bitcoin.Psbt.fromBase64(order, { network: NETWORK })

        const theirTxid = hashToId(psbt.txInputs[0].hash)
        const theirVout = psbt.txInputs[0].index

        const outpoint = theirTxid + '_' + theirVout

        const theirDemandedBtc = psbt.txOutputs[0].value
        if (ordersMap[outpoint] && ordersMap[outpoint].theirDemandedBtc < theirDemandedBtc)
            continue;

        const outspends = await Esplora.fetchTransactionOutspends(theirTxid)

        if (outspends[theirVout].spent) continue;

        // Store that output in our hashmap
        ordersMap[outpoint] = {
            order,
            theirDemandedBtc
        }
    }
    const cleanOrderbook = Object.values(ordersMap).map(o => o.order)
    
    return cleanOrderbook
}

async function sendOrderbook(ws) {
    orderbook = await cleanOrderbook(orderbook)
    ws.send(JSON.stringify(orderbook))
}

wss.on('connection', ws => {
    ws.on('message', msg => onMessage(msg, ws))
    sendOrderbook(ws)
})