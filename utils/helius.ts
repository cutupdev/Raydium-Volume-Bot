import {
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js"
import bs58 from "bs58";
import { solanaConnection as connection, mainKp } from "..";
import { RPC_ENDPOINT } from "../constants";


async function getPriorityFeeEstimate(priorityLevel: string, transaction: Transaction) {
  const response = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "getPriorityFeeEstimate",
      params: [
        {
          transaction: bs58.encode(transaction.serialize()), // Pass the serialized transaction in Base58
          options: { priorityLevel: priorityLevel },
        },
      ],
    }),
  });
  const data = await response.json();
  console.log(
    "Fee in function for",
    priorityLevel,
    " :",
    data.result.priorityFeeEstimate
  );
  return data.result;
}
async function sendTransactionWithPriorityFee(priorityLevel: string, transaction: Transaction) {
 
  transaction.recentBlockhash = (
    await connection.getLatestBlockhash()
  ).blockhash;
  transaction.sign(mainKp);

  let feeEstimate = { priorityFeeEstimate: 0 };
  if (priorityLevel !== "NONE") {
    feeEstimate = await getPriorityFeeEstimate(priorityLevel, transaction);
    const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: feeEstimate.priorityFeeEstimate,
    });
    transaction.add(computePriceIx);
  }

  try {
    const txid = await sendAndConfirmTransaction(connection, transaction, [
      mainKp,
    ]);
    console.log(`Transaction sent successfully with signature ${txid}`);
  } catch (e) {
    console.error(`Failed to send transaction: ${e}`);
  }
}

// sendTransactionWithPriorityFee("High"); // Choose between "Min", "Low", "Medium", "High", "VeryHigh", "UnsafeMax"
