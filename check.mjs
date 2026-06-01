#!/usr/bin/env node
/**
 * 🔍 Seed Phrase → Wallet Address Checker
 * 
 * Derives SOL, ETH, and TRX addresses from a seed phrase
 * and checks balances on each chain.
 * 
 * USDT is a token on ETH/TRX/SOL — balances shown where found.
 * 
 * Usage:
 *   node check.mjs
 *   (then paste your seed phrase when prompted)
 * 
 * ⚠️ RUN THIS LOCALLY ONLY — never on a remote/shared machine
 */

import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import TronWebModule from "tronweb";
const TronWeb = TronWebModule.default || TronWebModule;
import { createInterface } from "readline";

// ─── Config ──────────────────────────────────────────────────────────

const RPC = {
  solana: "https://api.mainnet-beta.solana.com",
  ethereum: "https://eth.llamarpc.com",
  tron: "https://api.trongrid.io",
};

// USDT contract addresses
const USDT = {
  eth: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  tron: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  // SOL USDT = EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (USDC actually, USDT is Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB)
  sol: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  solUsdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

// ─── Derivation ──────────────────────────────────────────────────────

function deriveSolana(seed) {
  // Standard Solana derivation path
  const path = "m/44'/501'/0'/0'";
  const derived = derivePath(path, seed.toString("hex"));
  const keypair = Keypair.fromSeed(derived.key);
  return {
    chain: "SOL",
    address: keypair.publicKey.toBase58(),
    publicKey: keypair.publicKey,
  };
}

function deriveEthereum(mnemonic) {
  // Standard ETH derivation: m/44'/60'/0'/0/0
  const wallet = ethers.Wallet.fromPhrase(mnemonic);
  return {
    chain: "ETH",
    address: wallet.address,
  };
}

function deriveTron(mnemonic) {
  // TRX uses same derivation as ETH but different address encoding
  // m/44'/195'/0'/0/0
  const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/195'/0'/0/0");
  const privKey = hdNode.privateKey.slice(2);
  
  let address;
  try {
    // Try static method
    if (TronWeb.address && typeof TronWeb.address.fromPrivateKey === "function") {
      address = TronWeb.address.fromPrivateKey(privKey);
    } else {
      // Try instance method
      const tw = new TronWeb({ fullHost: "https://api.trongrid.io" });
      if (tw.address && typeof tw.address.fromPrivateKey === "function") {
        address = tw.address.fromPrivateKey(privKey);
      } else {
        // Manual: ETH address shares same key, just show it
        address = `${hdNode.address} (use in Tron wallet)`;
      }
    }
  } catch {
    address = `${hdNode.address} (ETH-format, import to TronLink)`;
  }
  
  return {
    chain: "TRX",
    address,
  };
}

// ─── Balance Checks ──────────────────────────────────────────────────

async function checkSolBalance(address) {
  try {
    const conn = new Connection(RPC.solana, "confirmed");
    const pubkey = new PublicKey(address);
    
    // SOL balance
    const balance = await conn.getBalance(pubkey);
    const solBalance = balance / 1e9;

    // SPL token balances (USDT + USDC)
    let usdtBalance = 0;
    let usdcBalance = 0;
    try {
      const tokens = await conn.getParsedTokenAccountsByOwner(pubkey, {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });
      for (const t of tokens.value) {
        const info = t.account.data.parsed.info;
        const mint = info.mint;
        const amount = info.tokenAmount.uiAmount || 0;
        if (mint === USDT.sol) usdtBalance = amount;
        if (mint === USDT.solUsdc) usdcBalance = amount;
      }
    } catch (_) {}

    return { sol: solBalance, usdt: usdtBalance, usdc: usdcBalance };
  } catch (err) {
    return { sol: 0, usdt: 0, usdc: 0, error: err.message };
  }
}

async function checkEthBalance(address) {
  try {
    const provider = new ethers.JsonRpcProvider(RPC.ethereum);
    
    // ETH balance
    const balance = await provider.getBalance(address);
    const ethBalance = parseFloat(ethers.formatEther(balance));

    // USDT balance
    let usdtBalance = 0;
    try {
      const usdtContract = new ethers.Contract(
        USDT.eth,
        ["function balanceOf(address) view returns (uint256)"],
        provider
      );
      const usdtRaw = await usdtContract.balanceOf(address);
      usdtBalance = parseFloat(ethers.formatUnits(usdtRaw, 6));
    } catch (_) {}

    return { eth: ethBalance, usdt: usdtBalance };
  } catch (err) {
    return { eth: 0, usdt: 0, error: err.message };
  }
}

async function checkTrxBalance(address) {
  try {
    const tronWeb = new TronWeb({ fullHost: RPC.tron });
    
    // TRX balance
    const balanceSun = await tronWeb.trx.getBalance(address);
    const trxBalance = balanceSun / 1e6;

    // USDT (TRC-20) balance
    let usdtBalance = 0;
    try {
      const contract = await tronWeb.contract().at(USDT.tron);
      const usdtRaw = await contract.methods.balanceOf(address).call();
      usdtBalance = Number(usdtRaw) / 1e6;
    } catch (_) {}

    return { trx: trxBalance, usdt: usdtBalance };
  } catch (err) {
    return { trx: 0, usdt: 0, error: err.message };
  }
}

// ─── Display ─────────────────────────────────────────────────────────

function printResult(wallet, balances) {
  const line = "─".repeat(58);
  console.log(`\n┌${line}┐`);
  console.log(`│ ${wallet.chain.padEnd(5)} │ ${wallet.address.padEnd(49)} │`);
  console.log(`├${line}┤`);
  
  for (const [token, amount] of Object.entries(balances)) {
    if (token === "error") {
      console.log(`│  ⚠️  Error: ${amount.substring(0, 43).padEnd(43)} │`);
    } else {
      const symbol = token.toUpperCase();
      const val = amount > 0 ? `${amount}` : "0";
      const indicator = amount > 0 ? "💰" : "  ";
      console.log(`│  ${indicator} ${symbol.padEnd(6)} ${val.padEnd(47)} │`);
    }
  }
  console.log(`└${line}┘`);
}

// ─── Main ────────────────────────────────────────────────────────────

async function processPhrase(mnemonic) {
  mnemonic = mnemonic.trim().toLowerCase();

  // Validate
  if (!bip39.validateMnemonic(mnemonic)) {
    console.error("❌ Invalid seed phrase. Check for typos.");
    return;
  }

  const wordCount = mnemonic.split(/\s+/).length;
  console.log(`\n✅ Valid seed phrase (${wordCount} words)`);
  console.log("🔍 Deriving addresses & checking balances...\n");

  const seed = await bip39.mnemonicToSeed(mnemonic);

  // Derive addresses
  const solWallet = deriveSolana(seed);
  const ethWallet = deriveEthereum(mnemonic);
  const trxWallet = deriveTron(mnemonic);

  // Check balances in parallel
  const [solBal, ethBal, trxBal] = await Promise.all([
    checkSolBalance(solWallet.address),
    checkEthBalance(ethWallet.address),
    checkTrxBalance(trxWallet.address),
  ]);

  // Display
  printResult(solWallet, solBal);
  printResult(ethWallet, ethBal);
  printResult(trxWallet, trxBal);

  // Summary
  const totalUsdt = (solBal.usdt || 0) + (ethBal.usdt || 0) + (trxBal.usdt || 0);
  console.log("\n📊 Summary:");
  console.log(`   SOL: ${solBal.sol}  |  ETH: ${ethBal.eth}  |  TRX: ${trxBal.trx}`);
  if (totalUsdt > 0) console.log(`   Total USDT across chains: ${totalUsdt}`);
  if (solBal.usdc > 0) console.log(`   USDC (SOL): ${solBal.usdc}`);
  
  const hasAny = solBal.sol > 0 || ethBal.eth > 0 || trxBal.trx > 0 || totalUsdt > 0;
  if (hasAny) {
    console.log("\n   💰 This wallet has funds!");
  } else {
    console.log("\n   📭 No funds found on this seed.");
  }
}

// ─── Interactive Mode ────────────────────────────────────────────────

console.log("═".repeat(60));
console.log("  🔍 Seed Phrase → Multi-Chain Wallet Checker");
console.log("  Chains: Solana · Ethereum · Tron");
console.log("  Tokens: SOL · ETH · TRX · USDT · USDC");
console.log("═".repeat(60));
console.log("\n⚠️  Only run this on YOUR machine. Never share seeds.\n");

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask() {
  rl.question('🔑 Paste seed phrase (or "q" to quit): ', async (input) => {
    if (input.trim().toLowerCase() === "q") {
      console.log("\n👋 Done. Stay safe out there.");
      rl.close();
      return;
    }
    await processPhrase(input);
    console.log("\n" + "─".repeat(60) + "\n");
    ask();
  });
}

ask();
