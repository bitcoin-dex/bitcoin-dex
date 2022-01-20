// This handles the communication with our backend

function toBase64(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)))
}

function fromBase64(string) {
    return Uint8Array.from(atob(string), c => c.charCodeAt(0))
}


let socket = null;

function connectToServer() {
    socket = new WebSocket(ORDERBOOK_BACKEND_URL)
    socket.onclose = _ => setTimeout(connectToServer, 3000) // <- rise from your grave!
    socket.onopen = heartbeat
    socket.onmessage = async e => {
        if (e.data.arrayBuffer) {
            const buffer = await e.data.arrayBuffer()
            const base64 = toBase64(buffer)
            onOffer(base64)
        } else {
            onInit(JSON.parse(e.data))
        }
    }
}

let orderbook = []

async function onOffer(offerPsbt) {
    const offer = await parseOffer(offerPsbt)
    orderbook.push(offer)
    updateOrderbook(orderbook)
}


async function onInit(orders) {
    orderbook = []
    for (var i = 0; i < orders.length; i++) {
        const rawOffer = orders[i].data
        try {
            const offer = await parseOffer(toBase64(rawOffer))
            orderbook.push(offer)
        } catch (e) {
            console.warn(e)
        }
    }
    console.log(orders, orderbook)
    updateOrderbook(orderbook)
}

function heartbeat() {
    if (!socket) return;
    if (socket.readyState !== 1) return;
    socket.send('heartbeat');
    setTimeout(heartbeat, 10000);
}


function updateOrderbook(orderbook) {
    orderbook = cleanOrderbook(orderbook)
    console.table(orderbook)
    displayOrderbook(orderbook)
}

function cleanOrderbook(orderbook) {
    // Sort orderbook by price
    orderbook = orderbook.sort((o1, o2) => o2.exchangeRate - o1.exchangeRate)

    return orderbook
}