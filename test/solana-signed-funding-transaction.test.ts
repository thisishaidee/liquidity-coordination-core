import { address, createNoopSigner } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { verifySignedUsdcFundingTransaction } from "../src/solana-funding-transaction";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BLOCKHASH = "11111111111111111111111111111111";
const AMOUNT = 5_000_000n;

async function buildSignedTransaction(options: {
  feePayer?: Keypair;
  source?: Keypair;
  destination?: Keypair;
  amount?: bigint;
  extraInstruction?: boolean;
  signSource?: boolean;
} = {}) {
  const feePayer = options.feePayer ?? Keypair.generate();
  const source = options.source ?? Keypair.generate();
  const destination = options.destination ?? Keypair.generate();
  const feePayerAddress = feePayer.publicKey.toBase58();
  const sourceAddress = source.publicKey.toBase58();
  const destinationAddress = destination.publicKey.toBase58();
  const [sourceAta] = await findAssociatedTokenPda({
    mint: address(MINT), owner: address(sourceAddress), tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  const [destinationAta] = await findAssociatedTokenPda({
    mint: address(MINT), owner: address(destinationAddress), tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 99n
  });
  transaction.add(getTransferCheckedInstruction({
    source: sourceAta,
    mint: address(MINT),
    destination: destinationAta,
    authority: createNoopSigner(address(sourceAddress)),
    amount: options.amount ?? AMOUNT,
    decimals: 6
  }));
  if (options.extraInstruction) {
    transaction.add(new TransactionInstruction({
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      keys: [],
      data: new Uint8Array([1])
    }));
  }
  const signers = feePayer.publicKey.equals(source.publicKey) || options.signSource === false
    ? [feePayer] : [feePayer, source];
  await transaction.partialSign(...signers);
  const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  return {
    bytes: new Uint8Array(bytes),
    feePayerAddress,
    sourceAddress,
    destinationAddress
  };
}

describe("verifySignedUsdcFundingTransaction", () => {
  it("accepts an exactly signed USDC transfer with distinct fee payer and source owner", async () => {
    const signed = await buildSignedTransaction();
    const verified = await verifySignedUsdcFundingTransaction(signed.bytes, {
      mintAddress: MINT,
      sourceWalletAddress: signed.sourceAddress,
      destinationOwnerAddress: signed.destinationAddress,
      feePayerAddress: signed.feePayerAddress,
      amountAtoms: AMOUNT.toString()
    });
    expect(verified.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,100}$/);
    expect(verified.messageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verified.recentBlockhash).toBe(BLOCKHASH);
  });

  it("accepts one signer when the fee payer is also the token owner", async () => {
    const sameWallet = Keypair.generate();
    const signed = await buildSignedTransaction({ feePayer: sameWallet, source: sameWallet });
    const verified = await verifySignedUsdcFundingTransaction(signed.bytes, {
      mintAddress: MINT,
      sourceWalletAddress: signed.sourceAddress,
      destinationOwnerAddress: signed.destinationAddress,
      feePayerAddress: signed.feePayerAddress,
      amountAtoms: AMOUNT.toString()
    });
    expect(verified.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,100}$/);
  });

  it("rejects a missing source-owner signature", async () => {
    const signed = await buildSignedTransaction({ signSource: false });
    await expect(verifySignedUsdcFundingTransaction(signed.bytes, {
      mintAddress: MINT,
      sourceWalletAddress: signed.sourceAddress,
      destinationOwnerAddress: signed.destinationAddress,
      feePayerAddress: signed.feePayerAddress,
      amountAtoms: AMOUNT.toString()
    })).rejects.toThrow("missing or invalid required signature");
  });

  it("rejects a transfer amount that differs from the reservation", async () => {
    const signed = await buildSignedTransaction({ amount: AMOUNT + 1n });
    await expect(verifySignedUsdcFundingTransaction(signed.bytes, {
      mintAddress: MINT,
      sourceWalletAddress: signed.sourceAddress,
      destinationOwnerAddress: signed.destinationAddress,
      feePayerAddress: signed.feePayerAddress,
      amountAtoms: AMOUNT.toString()
    })).rejects.toThrow("amount does not match");
  });

  it("rejects extra instructions even when every signature is valid", async () => {
    const signed = await buildSignedTransaction({ extraInstruction: true });
    await expect(verifySignedUsdcFundingTransaction(signed.bytes, {
      mintAddress: MINT,
      sourceWalletAddress: signed.sourceAddress,
      destinationOwnerAddress: signed.destinationAddress,
      feePayerAddress: signed.feePayerAddress,
      amountAtoms: AMOUNT.toString()
    })).rejects.toThrow("exactly one approved checked USDC transfer");
  });

  it("rejects a transaction signed by a different fee payer", async () => {
    const signed = await buildSignedTransaction();
    await expect(verifySignedUsdcFundingTransaction(signed.bytes, {
      mintAddress: MINT,
      sourceWalletAddress: signed.sourceAddress,
      destinationOwnerAddress: signed.destinationAddress,
      feePayerAddress: Keypair.generate().publicKey.toBase58(),
      amountAtoms: AMOUNT.toString()
    })).rejects.toThrow("fee payer does not match");
  });
});
