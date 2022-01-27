# Optimistic 2-way Peg

A protocol to peg ETH existing on the Ethereum blockchain to _"wETH"_ (wrapped ETH) existing on the Bitcoin blockchain. The peg is trustless. It has a small onchain footprint because proof data is required only in case of an attack. Attackers are guaranteed to lose money. The peg works for all assets on all major smart contract platforms. ETH is used only as an example here.

## Assumptions
- We assume all parties run (SPV) clients for both Ethereum and Bitcoin.
- You as a token holder (or any honest party) watch the Ethereum chain at least once a week.
- We assume a Colored Coins protocol to represent wETH on top of Bitcoin (e.g. [Bitcoin DEX](https://github.com/bitcoin-dex/bitcoin-dex/blob/main/bitcoin-dex.md), Omni, or maybe RGB).
- We assume the Ethereum miners can't censor all honest users for one week.

## Peg-In 
The peg-in is simple. Scenario: _Alice_ wants to lock ETH on Ethereum and receive wETH on Bitcoin.

1. Alice locks ETH in the peg contract on Ethereum. 
    1. Alice has to reference a particular UTXO for her to use to mint the wETH on bitcoin.
3. Alice mints equally much wETH for herself on Bitcoin. 
    1. Alice has to reference the hash of her Ethereum transaction.
4. Whenever a Bob receives wETH with a transaction history originating in this genesis, he verifies Alice's lock transaction in Ethereum.

## Peg-Out
The peg-out is a bit more tricky. Scenario: _Carol_ wants to redeem wETH on Bitcoin for ETH on Ethereum:

1. Carol burns her wETH with a _burn transaction_ on Bitcoin. 
1. Carol makes a claim to withdraw that much ETH from the locking contract on Ethereum. 
    1. Carol has to reference a hash of her burn transaction.
    1. Carol has to lock a collateral. This is to ensure she gets punished in case her claim was dishonest.
1. A challenge period starts (for example one week). Everybody can verify Carol's claim from public data. Every Dave can accuse Carol to be dishonest. 
    1. Dave has to lock a collateral to make an accusation. This is to ensure he gets punished in case his accusation was dishonest.
1. If Carol was not challenged before the period expired, then she can withdraw the ETH she claimed without providing any proof.
1. Otherwise, if she was challenged, she has to provide a SPV proof proving her entire wETH token history to the Ethereum blockchain.
    1. If Carol provides a correct proof then she can take the claimed ETH, and Dave loses his collateral to her.
    1. If Carol doesn't provide a correct proof on time then she loses her collateral to Dave.

This is the basic protocol. The following are optimisations.

## Proof Data Compression
Carol's coin history can become quite large. Thus, we want to compress it to save fees. There are a couple of simple improvements possible: 
- Use [header chain compression for the SPV proofs](https://github.com/alecalve/headergolf)
- Strip off all witness data from all TXs. (Requires the Colored Coins protocol to be constraint to SegWit TXs)
- Strip off all TXIDs and compute them from previous TXs
- Store proof data in the contract such that others can reuse them later as basis for their proofs.

The following ideas are more sophisticated and are based on the idea to find the point of disagreement with as little proof data as possible. Disclaimer: The constructions are very hand-wavy on the details.


### Deterministic History Commitments
It is possible to define history commitments to be deterministic such that the correct commitment value can be publicly derived from bitcoin's blockchain. This ensures, to resolve a conflict, both parties have to provide only the first part of their histories where they differ from each other. This reduces the required proof data significantly.

The following is an idea to disprove invalid history commitments succinctly. However, for now, we will not combine it with deterministic commitments for the sake of making the core concept easier to understand.

### Compact History Commitment

Can Carol commit to a more compact coin history such that it is always possible to disprove an invalid history with a succinct counter-proof?

_Output paths_ are helpful to do that. We can reference every output in the Bitcoin blockchain by its _path_
```
path = block_height / transaction_index / output_index
```

Carol's coin history is a directed acyclic graph originating in genesis outputs. She can commit to her history by describing its graph with a set of output paths and corresponding wETH values. Its consistency can be validated by the contract. This is cheap because it requires no hashing. 

We can require Alice to commit to an output path in her ETH transaction. Furthermore, we require that she has to use the corresponding UTXO to mint her wETH on Bitcoin. This ensures the paths of all genesis outputs are known to the Ethereum contract. So, Carol's history has to originate in those genesis paths. 

Carol can encode a commitment to a coin history with hundreds of transactions in about 2kB. Most importantly, this commitment allows others to succinctly disprove an invalid history with public data. 

Assuming the underlying Colored Coins protocol is sufficiently simple and explicit, Dave should be able to disprove an invalid coin history with only a single bitcoin transaction and an inclusion proof for it. Merkle proofs play nicely together with output paths as they implicitly proof the transaction's index. A commitment to a block's height is in its coinbase output (see [BIP34](https://en.bitcoin.it/wiki/BIP_0034)). Thus, output paths are anchored into the proof-of-work of SPV proofs. Verifying Bitcoin SPV proofs on other chains has been [researched extensively](https://github.com/summa-tx/bitcoin-spv/tree/master/solidity).

Ideally, Ethereum should be aware of bitcoin's full headers chain. There have been projects trying to do that but it seems like they turned out to be too expensive.


## Generalisation 
- The protocol works with any asset on any  blockchain that can implement the peg-out contract. For example, any ERC-20 token, or assets on Binance Chain, Cardano or Solana. 
- In theory, `OP_CAT` would suffice to implement the peg even in Bitcoin Script. Thus, it should be possible to implement the peg on Liquid or Bitcoin Cash because they've activated this opcode in their Bitcoin Script dialect.
- In combination with [the Bitcoin DEX protocol](https://github.com/bitcoin-dex/bitcoin-dex/blob/main/bitcoin-dex.md) this peg allows to trade any shitcoin against BTC in a cypherpunk way.
- Confidential transactions might be compatible if there's a way to verify range proofs on EVM.
