import { address, createNoopSigner } from "@solana/kit";
import {
  AccountState,
  findAssociatedTokenPda,
  getMintDecoder,
  getTokenDecoder,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

export type UsdcFundingTransactionInput = {
  rpcUrl: string;
  mintAddress: string;
  sourceWalletAddress: string;
  destinationOwnerAddress: string;
  feePayerAddress: string;
  amountAtoms: string;
  maximumFeeLamports: string;
  remainingAggregateFeeLamports: string;
};

export type UsdcFundingTransactionResult = {
  transactionBase64: string;
  messageSha256: string;
  sourceTokenAccount: string;
  destinationTokenAccount: string;
  sourceWalletAddress: string;
  destinationOwnerAddress: string;
  feePayerAddress: string;
  mintAddress: string;
  amountAtoms: string;
  decimals: 6;
  recentBlockhash: string;
  lastValidBlockHeight: string;
  estimatedFeeLamports: string;
  requiredSigners: string[];
};

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds an unsigned, single-transfer USDC transaction. It never signs or
 * broadcasts. The source owner and fee payer are represented as no-op SDK
 * signers so both remain explicit required signer slots in the compiled tx.
 */
export async function buildUsdcFundingTransaction(
  input: UsdcFundingTransactionInput,
  suppliedConnection?: Connection
): Promise<UsdcFundingTransactionResult> {
  if (!/^https:\/\//i.test(input.rpcUrl)) throw new Error("Solana RPC endpoint must use HTTPS.");
  if (!/^[1-9][0-9]{0,18}$/.test(input.amountAtoms) || BigInt(input.amountAtoms) <= 0n) {
    throw new Error("Funding amount must be a positive canonical atom amount.");
  }
  for (const [label, value] of [
    ["maximum fee", input.maximumFeeLamports],
    ["remaining aggregate fee", input.remainingAggregateFeeLamports]
  ] as const) {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) throw new Error("Approved " + label + " is invalid.");
  }

  const mintKey = new PublicKey(input.mintAddress);
  const sourceOwnerKey = new PublicKey(input.sourceWalletAddress);
  const destinationOwnerKey = new PublicKey(input.destinationOwnerAddress);
  const feePayerKey = new PublicKey(input.feePayerAddress);
  const tokenProgramKey = new PublicKey(TOKEN_PROGRAM_ADDRESS);
  if (sourceOwnerKey.equals(destinationOwnerKey)) throw new Error("Source and destination wallets must be different.");

  const connection = suppliedConnection ?? new Connection(input.rpcUrl, "finalized");
  const [sourceAta] = await findAssociatedTokenPda({
    mint: address(input.mintAddress),
    owner: address(input.sourceWalletAddress),
    tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  const [destinationAta] = await findAssociatedTokenPda({
    mint: address(input.mintAddress),
    owner: address(input.destinationOwnerAddress),
    tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  if (sourceAta === destinationAta) throw new Error("Source and destination token accounts must be different.");

  const [mintAccount, sourceAccount, destinationAccount] = await Promise.all([
    connection.getAccountInfo(mintKey, "finalized"),
    connection.getAccountInfo(new PublicKey(sourceAta), "finalized"),
    connection.getAccountInfo(new PublicKey(destinationAta), "finalized")
  ]);
  if (!mintAccount || !mintAccount.owner.equals(tokenProgramKey)) {
    throw new Error("Configured USDC mint is missing or is not owned by the canonical SPL Token Program.");
  }
  const mint = getMintDecoder().decode(new Uint8Array(mintAccount.data));
  if (!mint.isInitialized || mint.decimals !== 6) {
    throw new Error("Configured USDC mint is not initialized with exactly six decimals.");
  }
  if (!sourceAccount || !sourceAccount.owner.equals(tokenProgramKey)) {
    throw new Error("Registered source wallet does not have its canonical USDC associated token account.");
  }
  const source = getTokenDecoder().decode(new Uint8Array(sourceAccount.data));
  if (source.state !== AccountState.Initialized ||
      source.owner !== input.sourceWalletAddress || source.mint !== input.mintAddress) {
    throw new Error("Source token account owner, mint or state does not match the registered wallet.");
  }
  if (source.amount < BigInt(input.amountAtoms)) {
    throw new Error("Source token account does not contain the exact reserved USDC amount.");
  }
  if (!destinationAccount || !destinationAccount.owner.equals(tokenProgramKey)) {
    throw new Error("Recipient USDC associated token account does not exist. NERITH will not spend unbudgeted rent to create it.");
  }
  const destination = getTokenDecoder().decode(new Uint8Array(destinationAccount.data));
  if (destination.state !== AccountState.Initialized ||
      destination.owner !== input.destinationOwnerAddress || destination.mint !== input.mintAddress) {
    throw new Error("Recipient token account owner, mint or state does not match the approved destination.");
  }

  const lifetime = await connection.getLatestBlockhash("finalized");
  const transaction = new Transaction({
    feePayer: feePayerKey,
    blockhash: lifetime.blockhash,
    lastValidBlockHeight: lifetime.lastValidBlockHeight
  });
  transaction.add(getTransferCheckedInstruction({
    source: sourceAta,
    mint: address(input.mintAddress),
    destination: destinationAta,
    authority: createNoopSigner(address(input.sourceWalletAddress)),
    amount: BigInt(input.amountAtoms),
    decimals: 6
  }));

  const estimatedFee = await transaction.getEstimatedFee(connection);
  if (estimatedFee === null || !Number.isSafeInteger(estimatedFee) || estimatedFee < 0) {
    throw new Error("Solana RPC could not estimate the finalized transaction fee.");
  }
  const fee = BigInt(estimatedFee);
  if (fee > BigInt(input.maximumFeeLamports) ||
      fee > BigInt(input.remainingAggregateFeeLamports)) {
    throw new Error("Estimated network fee exceeds the approved per-transaction or remaining aggregate fee budget.");
  }
  const feePayerBalance = await connection.getBalance(feePayerKey, "finalized");
  if (!Number.isSafeInteger(feePayerBalance) || feePayerBalance < estimatedFee) {
    throw new Error("Registered fee payer does not have enough finalized SOL to cover the estimated network fee.");
  }

  const messageBytes = transaction.serializeMessage();
  const unsignedBytes = await transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false
  });
  const requiredSigners = input.feePayerAddress === input.sourceWalletAddress
    ? [input.feePayerAddress]
    : [input.feePayerAddress, input.sourceWalletAddress];

  return {
    transactionBase64: encodeBase64(unsignedBytes),
    messageSha256: await sha256(messageBytes),
    sourceTokenAccount: sourceAta,
    destinationTokenAccount: destinationAta,
    sourceWalletAddress: input.sourceWalletAddress,
    destinationOwnerAddress: input.destinationOwnerAddress,
    feePayerAddress: input.feePayerAddress,
    mintAddress: input.mintAddress,
    amountAtoms: input.amountAtoms,
    decimals: 6,
    recentBlockhash: lifetime.blockhash,
    lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
    estimatedFeeLamports: fee.toString(),
    requiredSigners
  };
}
