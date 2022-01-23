# Bitcoin DeFi Vision 
The Bitcoin DEX originates in my wish list for decentralised finance on bitcoin:

1. An algorithmic stablecoin, "USDx", on top of bitcoin.
2. Decentralised exchange with high liquidity for BTC/USDx.
3. Lightning network support for USDx.
4. Confidential transactions for USDx.

Some of the above might be impossible, but the general research direction seems fruitful. The purpose of this project is to systematically explore the above vision for DeFi on Bitcoin. You are invited to criticise and contribute ideas.

The following is a discussion of a protcol for a decentralised exchange. For now, all other items on the wish list are ignored.

# Bitcoin DEX Protocol
On a _Bitcoin DEX_ you can trade Colored Coins against Bitcoins. It is permissionless, non-custodial and requires no central party to operate it. Order matching happens mostly offchain, so the onchain footprint for a swap is small, which makes it feasible on top of bitcoin. By introducing [trust minimized orderbook servers](#trust-assumptions-for-orderbook-servers) to update orders offchain, the protocol becomes fast and responsive enough for market makers to provide liquidity.

The _Bitcoin DEX protocol_ consists of three protocols which together form a decentralised bitcoin exchange. 

- **Bitcoin tokens**: the underlying Colored Coins protocol.
- **Non-interactive swaps**: the core of the trading protocol.
- **Orderbook servers**: the order matching protocol.

## Bitcoin Tokens Protocol
**Bitcoin tokens** are a Colored Coins protocol that is modulated on top of the bitcoin protocol. It uses client-side validation. 
In its current form it is very basic and quite similar to the Omni protocol. It simply encodes the tokens values in OP_RETURN outputs. 

We're planning to enhance the tokens protocol, e.g., with confidential transactions similar to the RGB protocol. Confidential transactions interoperate well with the rest of the Bitcoin DEX protocol.

(The Bitcoin DEX protocol doesn't rely on any particular Colored Coins protocol and should be compatible with a range of other token protocols such as Omni and RGB. We're mostly using a custom protocol for the sake of flexibility while exploring the solution space.)

## Non-interactive Swaps
Non-interactive atomic swaps allow you to swap Bitcoins against Bitcoin Tokens within a single bitcoin transaction, and without having to know your counter-party upfront.
<a href=https://bitcoin-dex.net/faq/atomic-swap.png><img src=https://bitcoin-dex.net/faq/atomic-swap.png></a>

Offers are simply incomplete bitcoin transactions signed with `sighash_single|anyonecanpay`.

### Offered Amounts
Here, Alice has to sell the full amount of her token UTXO. Ideally, the token protocol would allow Alice to encode her token change in her offer such that she can sell any amount she wants. The crux is that Bob may not invalidate Alice's token transaction.

The most simple solution is to use a second transaction for the swap. The first transaction splits up the UTXO's token amount into the UTXO to swap and the change UTXO, and the second transaction is the actual swap. 

#### Splitting up Offers 
Using two transactions for a swap makes offers much more flexible. E.g. it allows you to add to your offer the option to split it into multiple offers of smaller values. If you want you can charge higher prices for smaller offers. You can express all kinds of interesting conditions for takers just by signing multiple offers spending the same output

## Non-custodial Orderbook Servers
**Orderbook servers** relay the non-interactive swaps from offer makers to potential takers. Orderbook servers also ensure
1. that offers may be time limited 
2. the swap price may be updated without submitting a new order. 

The idea is inspired by the [Sideswap protocol](https://github.com/sideswap-io/sideswapclient/blob/master/doc/protocol.md) and is very similar to the ideas behind [Liquidex](https://leocomandini.github.io/2021/06/15/liquidex.html#liquidex-2-steps-atomic-swaps). Our orderbook protocol combines them.

### Orderbook Protocol
 Alice wants to sell her USD tokens for BTC. The process is simple:

1. Alice creates an offer and sends it to an orderbook server. (She can even go offline now. No further interaction is required.)
2. The server removes Alice's signature from the offer and broadcasts it to all Bobs. 
3. Any Bob, who wants to take the offer, verifies the offer, adds his BTC input and his USD output, and signs the full transaction. Then he sends it back to the server.
4. The server adds Alice's signature to complete the swap transaction. Then the server broadcasts the TX to the bitcoin network.

As long as nobody took her offer, Alice can update or cancel it. Then the server deletes Alice's signature for the outdated offer to guarantee it cannot get executed anymore.



### Trust Assumptions for Orderbook Servers
- Orderbook servers never hold any funds. 
- Orderbook servers are trusted to actually delete signatures for outdated offers. Otherwise, they can execute outdated offers. Orderbook servers are also trusted not to exploit free options. To be completely safe users have to update/cancel their offers via onchain transactions. 
- For every user, trust can be reduced to a single orderbook server which relays their offers to other orderbook servers but without signatures. Alternatively, a user can distribute trust among a t-of-n quorum of servers by splitting up their signature with Shamir secret sharing (or better, verifiable secret sharing?). 
- Offers should not use replace-by-fee. Otherwise, they become free options as soon as they are broadcasted to the bitcoin network. If the price moves while a swap TX is in the mempool (but not yet mined) then the "losing party" can cancel the trade by double-spending their output with RBF.
