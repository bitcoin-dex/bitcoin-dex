// SPDX-License-Identifier: GPL-3.0

pragma solidity ^0.5.10;

import "https://github.com/summa-tx/bitcoin-spv/blob/master/solidity/contracts/ViewBTC.sol";
import "https://github.com/summa-tx/bitcoin-spv/blob/master/solidity/contracts/ViewSPV.sol";

contract Peg {
    // 
    // Security Parameters
    //

    // Minimum work required in a headers chain 
    uint256 MIN_WORK; 
    // Minimum headers chain length
    uint32 MIN_CHAIN_LENGTH;
    // Minimum value required for a peg-in
    uint32 MIN_VALUE;

    constructor(uint256 minWork, uint32 minChainLength, uint32 minValue) public {
        MIN_WORK = minWork;
        MIN_CHAIN_LENGTH = minChainLength;
        MIN_VALUE = minValue;
    }

    // 
    // Constants to define valid bitcoin token transactions
    //
    
    // The tx version must be 2
    bytes4 constant VERSION = 0x02000000; 
    // All inputs must have 41 bytes == TXID(32) + vout(4) + publicScriptLen(1) + nSequence(4)
    uint32 constant VIN_LENGTH = 41;
    // All inputs must have segregated witnesses
    bytes1 constant PUBKEY_SCRIPT_LENGTH = 0x00; 
    // nSequence must be constant
    bytes4 constant SEQUENCE = 0xffffffff; 
    // A tx must have exactly three outputs
    bytes1 constant VOUT_COUNT = 0x03; 
    // All outputs must be p2wpkh (for now) // TODO: add p2pwsh and p2tr outputs
    bytes3 constant P2WPKH_PREFIX = 0x160014; 
    // The BTC value of the op_return output must be zero
    bytes8 constant OPRETURN_BTC_VALUE = 0x0000000000000000; 
    // A tx op_return encodes exactly 4 bytes (the token value of output_0)
    bytes3 constant OPRETURN_PREFIX = 0x066a04; 

    // The locktime must be zero
    bytes4 constant LOCKTIME = 0x00000000; 
    // A burn tx must have exactly one input
    bytes1 constant BURN_VIN_COUNT = 0x01;
    // A burn tx must have exactly one output
    bytes1 constant BURN_VOUT_COUNT = 0x01;
    // A burn tx op_return encodes exactly 20 bytes (the Ethereum address for the peg-out)
    bytes3 constant BURN_OPRETURN_PREFIX = 0x166a14;
    
    // Bitcoin headers are 80 bytes long
    uint32 constant HEADER_LENGTH = 80;
    
    // Minimum token unit for "common" values to fit into 32 bytes
    uint64 constant MIN_TOKEN_UNIT = 10000000000;
    // Maximum token value in uint32
    uint64 constant MAX_VALUE = 0xffffffff * MIN_TOKEN_UNIT;

    // 
    // Type definitions
    //
    using TypedMemView for bytes;
    using TypedMemView for bytes29;

    using ViewBTC for bytes29;
    using ViewSPV for bytes29;
    event PegInEvent(bytes32 txid, uint value);


    // 
    // Global state
    //

    // The genesis outputs and their token values   
    mapping(uint256 => uint32) public genesisOutpoints;

    // The Bitcoin Token utxo set
    mapping(uint256 => uint32) public utxoSet;

    // The used burn TXIDs
    mapping(bytes32 => bool) public usedBurnTxs;

    function pegIn(uint256 txid, uint32 vout) external payable {
        // Verify the minimum peg-in value
        require(msg.value >= MIN_TOKEN_UNIT, "Minimum peg-in value required");
        
        // Verify the outpoint is unused. Overwriting it could be dangerous!
        uint256 outpoint = txid + vout;
        require(genesisOutpoints[outpoint] == 0, "Outputs can be used only once");
        
        // Cast the value to 32 bits. Warning! This is dangerous. 
        // We have to limit the values to 2^32
        require(msg.value <= MAX_VALUE, "Maximum token value exceeded");
        uint32 value = uint32(msg.value / MIN_TOKEN_UNIT);

        // Set the outpoint's value to the value we received
        genesisOutpoints[outpoint] = value;

        // Tell the world about the peg-in
        emit PegInEvent(bytes32(outpoint), msg.value);

    }

    function pegOut(bytes memory chain, bytes memory proof, uint index, uint32 fundingVout, bytes memory history) public {
        // Verify the token history
        uint256 fundingTxid = verifyHistory(history);

        // Compile the burn TX
        bytes memory vin = abi.encodePacked(BURN_VIN_COUNT, fundingTxid, fundingVout, PUBKEY_SCRIPT_LENGTH, SEQUENCE);
        // Ensure the sender's Ethereum address is referenced in the op_return
        bytes memory vout = abi.encodePacked(BURN_VOUT_COUNT, OPRETURN_BTC_VALUE, BURN_OPRETURN_PREFIX, msg.sender );
        // Calculate the burnTxid
        bytes32 burnTxid = abi.encodePacked(VERSION, vin, vout, LOCKTIME).ref(0).hash256();        

        // Verify this burnTxid is unused
        require( usedBurnTxs[burnTxid] == false, "These coins were already redeemed");
        // Store this burnTxid as used
        usedBurnTxs[burnTxid] = true;

        // Verify the headers chain
        bytes32 merkleRoot = verifyChain(chain);

        // Verify the inclusion proof for this burnTxid
        bytes29 proofRef = proof.ref(0).tryAsMerkleArray().assertValid();
        require( ViewSPV.prove(burnTxid, merkleRoot, proofRef, index), "Invalid inclusion proof. Ensure you're calling the contract from the address referenced in your burn TX");

        // Get the burned token value from the UTXO set
        uint32 tokenValue = utxoSet[fundingTxid+fundingVout];

        // The prover passed all checks, so we give them the requested amount.
        msg.sender.transfer(tokenValue * MIN_TOKEN_UNIT);
    }
    

    function verifyChain(bytes memory chain) private returns (bytes32){
        // Compute the total work in the chain
        bytes29 headers = chain.ref(0).tryAsHeaderArray().assertValid();
        uint256 totalWork = headers.checkChain();
        
        // Verify that no error occured
        require(totalWork != ViewSPV.getErrBadLength(), "Bad length");
        require(totalWork != ViewSPV.getErrLowWork(), "Work too low");
        require(totalWork != ViewSPV.getErrInvalidChain(), "Invalid chain");

        // Verify the minimum amount of work in the chain
        require(totalWork > MIN_WORK, "More proof-of-work required");

        // Verify the minimum number of headers in the chain
        require(chain.length >= HEADER_LENGTH * MIN_CHAIN_LENGTH, "More headers required");

        // Get the first header in the chain
        bytes29 header = headers.indexHeaderArray(0);  
        // Return its merkle root
        return header.merkleRoot();
    }


    function verifyHistory(bytes memory history) private returns (uint256) {
        uint256 currTxid; 
        cursor = 0;    
        while(cursor < history.length){
            // Read vin count 
            uint8 vinCount = readUint8(history);
            // Allocate memory for all vins 
            bytes memory vins = new bytes(VIN_LENGTH * vinCount);
            // Compute sum of all inputs and compile them into one byte array
            uint32 inputTokenValueSum = 0;
            for(uint32 i = 0; i < vinCount; i++){
                uint256 txidIn = readUint256(history);
                // TODO: Cast uint8 to uint32 here
                uint32 vout = readUint32(history); 
                bytes memory vin = abi.encodePacked(txidIn, vout, PUBKEY_SCRIPT_LENGTH, SEQUENCE);
                uint256 outpoint = txidIn + reverse(vout); 
                // Read token value from utxo set
                // TODO: use safe math here!
                inputTokenValueSum += utxoSet[outpoint];
                // Add genesis value if there is one for this outpoint
                inputTokenValueSum += genesisOutpoints[outpoint];
                // Delete the utxo from our set
                utxoSet[outpoint] = 0;

                // Copy into vins 
                uint32 offset = i * VIN_LENGTH;
                for(uint32 j = 0; j < vin.length; j++){
                    vins[offset + j] = vin[j];
                }
            }

            // Read output0
            uint160 pubkeyhash0 = readUint160(history);
            uint64 btcValue0 = readUint64(history);
            // Read output1
            uint160 pubkeyhash1 = readUint160(history);
            uint64 btcValue1 = readUint64(history);
            // Read token value0
            uint32 tokenValue0 = readUint32(history);
            // Verify token value0 is not creating tokens out of thin air
            require(tokenValue0 <= inputTokenValueSum, "Invalid token value");
            // Compute token value1
            uint32 tokenValue1 = inputTokenValueSum - tokenValue0;

            // Compile the TX and calculate the TXID
            currTxid = uint256(
                abi.encodePacked(
                    abi.encodePacked(
                        VERSION, vinCount, vins, VOUT_COUNT, 
                        btcValue0, P2WPKH_PREFIX, pubkeyhash0), 
                    abi.encodePacked(
                        btcValue1, P2WPKH_PREFIX, pubkeyhash1,
                        OPRETURN_BTC_VALUE, OPRETURN_PREFIX, tokenValue0,
                        LOCKTIME)
            ).ref(0).hash256());

            // Insert outpoints into the UTXO set
            // TODO: what if someone misses a token input in a tx because it was not required to prove his output's (output0) value?
            utxoSet[currTxid] = tokenValue0;
            utxoSet[currTxid+1] = tokenValue1;
        }
        return currTxid;
    }

    function reverse(uint32 input) internal pure returns (uint32 v) {
        v = input;

        // Swap bytes
        v = ((v & 0xFF00FF00) >> 8) |
            ((v & 0x00FF00FF) << 8);

        // Swap 2-byte long pairs
        v = (v >> 16) | (v << 16);
    }


    // WARNING! UGLY HACK.
    // Our bytes library. lol 
    // This is ugly code smell and probably not how bytes should be handled in Solidity.
    // TODO: Clean this mess up!
    uint256 cursor = 0; 

    function readUint8(bytes memory _bytes)  internal returns (uint8) {
        require(_bytes.length >= cursor + 1 , "toUint8_outOfBounds");
        uint8 tempUint;

        uint256 _cursor = cursor;
        assembly {
            tempUint := mload(add(add(_bytes, 0x1), _cursor))
        }

        cursor += 1;
        return tempUint;
    }

    function readUint16(bytes memory _bytes)  internal returns (uint16) {
        require(_bytes.length >= cursor + 2, "toUint16_outOfBounds");
        uint16 tempUint;

        uint256 _cursor = cursor;
        assembly {
            tempUint := mload(add(add(_bytes, 0x2), _cursor))
        }

        cursor += 2;
        return tempUint;
    }

    function readUint32(bytes memory _bytes)  internal returns (uint32) {
        require(_bytes.length >= cursor + 4, "toUint32_outOfBounds");
        uint32 tempUint;

        uint256 _cursor = cursor;
        assembly {
            tempUint := mload(add(add(_bytes, 0x4), _cursor))
        }

        cursor += 4;
        return tempUint;
    }

    function readUint64(bytes memory _bytes)  internal returns (uint64) {
        require(_bytes.length >= cursor + 8, "toUint64_outOfBounds");
        uint64 tempUint;

        uint256 _cursor = cursor;
        assembly {
            tempUint := mload(add(add(_bytes, 0x8), _cursor))
        }

        cursor += 8;
        return tempUint;
    }

    function readUint160(bytes memory _bytes)  internal returns (uint160) {
        require(_bytes.length >= cursor + 20, "toUint160_outOfBounds");
        uint160 tempUint;

        uint256 _cursor = cursor;
        assembly {
            tempUint := mload(add(add(_bytes, 0x14), _cursor))
        }

        cursor += 20;
        return tempUint;
    }

    function readUint256(bytes memory _bytes)  internal returns (uint256) {
        require(_bytes.length >= cursor + 32, "toUint256_outOfBounds");
        uint256 tempUint;

        uint256 _cursor = cursor;
        assembly {
            tempUint := mload(add(add(_bytes, 0x20), _cursor))
        }

        cursor += 32;
        return tempUint;
    }

    function readBytes32(bytes memory _bytes) internal returns (bytes32) {
        require(_bytes.length >= cursor + 32, "toBytes32_outOfBounds");
        bytes32 tempBytes32;

        uint256 _cursor = cursor;
        assembly {
            tempBytes32 := mload(add(add(_bytes, 0x20), _cursor))
        }

        cursor += 32;
        return tempBytes32;
    }



}



// IDEA: let every peg-in commit to the current token UTXO set and a current bitcoin block hash.
// This utxo set commitment is verified client-side by the token recipient in bitcoin.
// This ensures, to forge a token history of value X, an attacker has to spend, for example, 1.1 * X.
// In addition to PoW, this is another economic game to find consensus on the entire token history.
// Another succinct proof, that is very expensive for attackers, but very cheap for honest users.
// It is used in peg-outs to compress the token history.
// Older tokens have to reference those newer tokens and thus, confirm their token history.
// PROBLEM: Attacker's don't lose money if they make an invalid commitment and then peg-out 
// because the contract doesn't know the truth



// IDEA: use locktime to prove a minimum block height for every TX
// This helps to develop a more robust notion of bitcoin block times
// We can require the locktimes increase every transaction
// This also allows us to set minimum times for token existence
// e.g. burnTx.locktime > 100 + genesisTx.locktime