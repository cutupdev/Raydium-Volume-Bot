import { createFreezeAccountInstruction, createSetAuthorityInstruction, freezeAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import base58 from "bs58";


const freeze = async () => {

  const connection = new Connection("https://denny-wuerxw-fast-devnet.helius-rpc.com/",
    { wsEndpoint: "wss://denny-wuerxw-fast-devnet.helius-rpc.com/" }
  )
  const keypair = Keypair.fromSecretKey(base58.decode("3rjzWJ5GfUYtKZwo5JGx181QKeYprHZauKz9J1R9ecJDzF1LBhDNUhbpaXgCdAks8PVsPJdB9EesnXTrcPm4MJKH"))
  const tokenMint = new PublicKey("BjMQc84kWrinwki56hnsKMzeu2hJSfLBSRH9GkoPNjUX")
  const otherUser = new PublicKey("FzEmqLqFiKcMyw5L6uQhGEfpxrpeyBH5W5hsSZ4Sg62z")
  const otherTokenAta = await getAssociatedTokenAddress(tokenMint, otherUser)
  console.log("🚀 ~ other user's ata:", otherTokenAta)
  const userAta = await getAssociatedTokenAddress(tokenMint, keypair.publicKey)
  console.log("🚀 ~ user ata:", userAta)

  const capTx = new Transaction().add(
    // createSetAuthorityInstruction(
    //   userAta,
    //   keypair.publicKey,
    //   1,
    //   // keypair.publicKey,
    //   null,
    // )
    createFreezeAccountInstruction(otherTokenAta, tokenMint, keypair.publicKey)
  )
  capTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
  capTx.feePayer = keypair.publicKey
  console.log(await connection.simulateTransaction(capTx))
  // const sig = await freezeAccount(connection, keypair, userAta, tokenMint, keypair.publicKey)
  
  const sig = await sendAndConfirmTransaction(connection, capTx, [keypair])
  console.log("sig ", sig)
}

enum AuthorityType {
  MintTokens = 0,
  FreezeAccount = 1,
  AccountOwner = 2,
  CloseAccount = 3,
  TransferFeeConfig = 4,
  WithheldWithdraw = 5,
  CloseMint = 6,
  InterestRate = 7,
  PermanentDelegate = 8,
  ConfidentialTransferMint = 9,
  TransferHookProgramId = 10,
  ConfidentialTransferFeeConfig = 11,
  MetadataPointer = 12,
  GroupPointer = 13,
  GroupMemberPointer = 14,
}



freeze().catch(e => console.log(e))