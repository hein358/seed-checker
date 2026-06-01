#!/usr/bin/env node
/**
 * 🔍 Batch Seed Checker — Read seeds from a text file
 * 
 * Usage:
 *   node check-file.mjs seeds.txt
 * 
 * seeds.txt format (one seed phrase per line):
 *   word1 word2 word3 ... word12
 *   word1 word2 word3 ... word12
 *   word1 word2 word3 ... word24
 * 
 * ⚠️ RUN LOCALLY ONLY — delete seeds.txt after checking!
 */

import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import TronWebModule from "tronweb";
import { createHash } from "node:crypto";
import fs from "fs";

const TronWeb = TronWebModule.default || TronWebModule;

// ─── Config ──────────────────────────────────────────────────────────

// Multiple RPCs for fallback when rate limited
const ETH_RPCS = [
  "https://rpc.ankr.com/eth",
  "https://eth.meowrpc.com",
  "https://1rpc.io/eth",
  "https://ethereum-rpc.publicnode.com",
];
let ethRpcIndex = 0;

const RPC = {
  solana: "https://api.mainnet-beta.solana.com",
  tron: "https://api.trongrid.io",
};

const USDT = {
  eth: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  tron: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  sol: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  solUsdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

// ─── Derivation ──────────────────────────────────────────────────────

function deriveSolana(seed) {
  const path = "m/44'/501'/0'/0'";
  const derived = derivePath(path, seed.toString("hex"));
  const keypair = Keypair.fromSeed(derived.key);
  return { chain: "SOL", address: keypair.publicKey.toBase58() };
}

function deriveEthereum(mnemonic) {
  const wallet = ethers.Wallet.fromPhrase(mnemonic);
  return { chain: "ETH", address: wallet.address };
}

function deriveTron(mnemonic) {
  const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/195'/0'/0/0");
  const ethAddr = hdNode.address; // 0x...
  
  // Convert ETH address to TRON address (base58check with 0x41 prefix)
  // ETH address = 0x + 20 bytes hex → TRON = 0x41 + same 20 bytes → base58check
  try {
    const addrBytes = Buffer.from(ethAddr.slice(2), "hex"); // 20 bytes
    const tronHex = Buffer.concat([Buffer.from([0x41]), addrBytes]); // 21 bytes
    
    // Double SHA256 for checksum
    const hash1 = createHash("sha256").update(tronHex).digest();
    const hash2 = createHash("sha256").update(hash1).digest();
    const checksum = hash2.slice(0, 4);
    
    const fullAddr = Buffer.concat([tronHex, checksum]); // 25 bytes
    
    // Base58 encode
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let num = BigInt("0x" + fullAddr.toString("hex"));
    let encoded = "";
    while (num > 0n) {
      const rem = Number(num % 58n);
      encoded = ALPHABET[rem] + encoded;
      num = num / 58n;
    }
    // Leading zeros
    for (const byte of fullAddr) {
      if (byte === 0) encoded = "1" + encoded;
      else break;
    }
    
    return { chain: "TRX", address: encoded };
  } catch {
    return { chain: "TRX", address: `${ethAddr} (convert in TronLink)` };
  }
}

// ─── Balance Checks ──────────────────────────────────────────────────

async function checkSolBalance(address) {
  try {
    const conn = new Connection(RPC.solana, "confirmed");
    const pubkey = new PublicKey(address);
    const balance = await conn.getBalance(pubkey);
    const solBalance = balance / 1e9;

    let usdtBalance = 0, usdcBalance = 0;
    try {
      const tokens = await conn.getParsedTokenAccountsByOwner(pubkey, {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });
      for (const t of tokens.value) {
        const info = t.account.data.parsed.info;
        if (info.mint === USDT.sol) usdtBalance = info.tokenAmount.uiAmount || 0;
        if (info.mint === USDT.solUsdc) usdcBalance = info.tokenAmount.uiAmount || 0;
      }
    } catch {}
    return { sol: solBalance, usdt: usdtBalance, usdc: usdcBalance };
  } catch (err) {
    return { sol: 0, usdt: 0, usdc: 0, error: err.message };
  }
}

async function checkEthBalance(address) {
  // Try multiple RPCs with fallback
  for (let attempt = 0; attempt < ETH_RPCS.length; attempt++) {
    const rpcUrl = ETH_RPCS[(ethRpcIndex + attempt) % ETH_RPCS.length];
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
        staticNetwork: ethers.Network.from("mainnet"),
      });
      const balance = await provider.getBalance(address);
      const ethBalance = parseFloat(ethers.formatEther(balance));

      let usdtBalance = 0;
      try {
        const c = new ethers.Contract(USDT.eth, ["function balanceOf(address) view returns (uint256)"], provider);
        usdtBalance = parseFloat(ethers.formatUnits(await c.balanceOf(address), 6));
      } catch {}
      
      ethRpcIndex = (ethRpcIndex + attempt + 1) % ETH_RPCS.length; // rotate for next call
      return { eth: ethBalance, usdt: usdtBalance };
    } catch {
      // Try next RPC
      continue;
    }
  }
  return { eth: 0, usdt: 0, error: "All ETH RPCs failed" };
}

async function checkTrxBalance(address) {
  try {
    const tronWeb = new TronWeb({ fullHost: RPC.tron });
    const balanceSun = await tronWeb.trx.getBalance(address);
    const trxBalance = balanceSun / 1e6;

    let usdtBalance = 0;
    try {
      const contract = await tronWeb.contract().at(USDT.tron);
      const raw = await contract.methods.balanceOf(address).call();
      usdtBalance = Number(raw) / 1e6;
    } catch {}
    return { trx: trxBalance, usdt: usdtBalance };
  } catch (err) {
    return { trx: 0, usdt: 0, error: err.message };
  }
}

// ─── Main ────────────────────────────────────────────────────────────

const file = process.argv[2];
if (!file) {
  console.error("Usage: node check-file.mjs <seeds.txt>");
  console.error("\nCreate a text file with one seed phrase per line.");
  process.exit(1);
}

if (!fs.existsSync(file)) {
  console.error(`❌ File not found: ${file}`);
  process.exit(1);
}

const lines = fs.readFileSync(file, "utf-8")
  .split("\n")
  .map(l => l.trim().toLowerCase())
  .filter(l => l && !l.startsWith("#")); // skip empty lines and comments

console.log("═".repeat(60));
console.log("  🔍 Batch Seed Checker");
console.log(`  📄 File: ${file}`);
console.log(`  📊 Seeds found: ${lines.length}`);
console.log("═".repeat(60));

// Totals
const totals = { sol: 0, eth: 0, trx: 0, usdt: 0, usdc: 0 };
const results = [];

for (let i = 0; i < lines.length; i++) {
  const mnemonic = lines[i];
  const num = i + 1;
  
  console.log(`\n${"━".repeat(60)}`);
  console.log(`  Wallet #${num}`);
  console.log(`${"━".repeat(60)}`);

  if (!bip39.validateMnemonic(mnemonic)) {
    const preview = mnemonic.split(" ").slice(0, 3).join(" ") + "...";
    console.log(`  ❌ Invalid seed: "${preview}"`);
    results.push({ num, valid: false });
    continue;
  }

  const wordCount = mnemonic.split(/\s+/).length;
  console.log(`  ✅ Valid (${wordCount} words)`);

  const seed = await bip39.mnemonicToSeed(mnemonic);
  const solW = deriveSolana(seed);
  const ethW = deriveEthereum(mnemonic);
  const trxW = deriveTron(mnemonic);

  console.log(`\n  SOL │ ${solW.address}`);
  console.log(`  ETH │ ${ethW.address}`);
  console.log(`  TRX │ ${trxW.address}`);

  console.log(`\n  ⏳ Checking balances...`);

  const [solBal, ethBal, trxBal] = await Promise.all([
    checkSolBalance(solW.address),
    checkEthBalance(ethW.address),
    checkTrxBalance(trxW.address),
  ]);

  // Display balances
  const balLines = [];
  if (solBal.sol > 0) balLines.push(`  💰 SOL:  ${solBal.sol}`);
  if (solBal.usdt > 0) balLines.push(`  💰 USDT (SOL): ${solBal.usdt}`);
  if (solBal.usdc > 0) balLines.push(`  💰 USDC (SOL): ${solBal.usdc}`);
  if (ethBal.eth > 0) balLines.push(`  💰 ETH:  ${ethBal.eth}`);
  if (ethBal.usdt > 0) balLines.push(`  💰 USDT (ETH): ${ethBal.usdt}`);
  if (trxBal.trx > 0) balLines.push(`  💰 TRX:  ${trxBal.trx}`);
  if (trxBal.usdt > 0) balLines.push(`  💰 USDT (TRX): ${trxBal.usdt}`);

  if (balLines.length > 0) {
    console.log(`\n  📊 Balances:`);
    balLines.forEach(l => console.log(l));
  } else {
    console.log(`\n  📭 No funds found`);
  }

  // Accumulate totals
  totals.sol += solBal.sol || 0;
  totals.eth += ethBal.eth || 0;
  totals.trx += trxBal.trx || 0;
  totals.usdt += (solBal.usdt || 0) + (ethBal.usdt || 0) + (trxBal.usdt || 0);
  totals.usdc += solBal.usdc || 0;

  results.push({
    num,
    valid: true,
    sol: solBal.sol, eth: ethBal.eth, trx: trxBal.trx,
    usdt: (solBal.usdt || 0) + (ethBal.usdt || 0) + (trxBal.usdt || 0),
    usdc: solBal.usdc || 0,
    hasFunds: balLines.length > 0,
    addresses: { sol: solW.address, eth: ethW.address, trx: trxW.address },
  });

  // Delay between wallets to avoid rate limits (3s)
  if (i < lines.length - 1) {
    console.log(`  ⏳ Waiting 3s before next wallet...`);
    await new Promise(r => setTimeout(r, 3000));
  }
}

// ─── Grand Total ─────────────────────────────────────────────────────

console.log(`\n\n${"═".repeat(60)}`);
console.log(`  📊 GRAND TOTAL — ${results.filter(r => r.valid).length} wallets checked`);
console.log(`${"═".repeat(60)}`);
console.log(`  SOL:  ${totals.sol}`);
console.log(`  ETH:  ${totals.eth}`);
console.log(`  TRX:  ${totals.trx}`);
console.log(`  USDT: ${totals.usdt}`);
console.log(`  USDC: ${totals.usdc}`);

const walletsWithFunds = results.filter(r => r.hasFunds);
if (walletsWithFunds.length > 0) {
  console.log(`\n  💰 Wallets with funds:`);
  for (const w of walletsWithFunds) {
    console.log(`    #${w.num}:`);
    if (w.sol > 0) console.log(`      SOL: ${w.sol} → ${w.addresses.sol}`);
    if (w.eth > 0) console.log(`      ETH: ${w.eth} → ${w.addresses.eth}`);
    if (w.trx > 0) console.log(`      TRX: ${w.trx} → ${w.addresses.trx}`);
    if (w.usdt > 0) console.log(`      USDT: ${w.usdt}`);
    if (w.usdc > 0) console.log(`      USDC: ${w.usdc}`);
  }
} else {
  console.log(`\n  📭 No funds found in any wallet`);
}

const invalid = results.filter(r => !r.valid);
if (invalid.length > 0) {
  console.log(`\n  ⚠️ ${invalid.length} invalid seed(s): #${invalid.map(r => r.num).join(", #")}`);
}

console.log(`\n${"═".repeat(60)}`);
console.log(`  ⚠️  Delete ${file} after checking! Don't leave seeds on disk.`);
console.log(`${"═".repeat(60)}\n`);
