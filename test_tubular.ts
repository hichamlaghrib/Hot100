import { fetchTubularDailyHistory } from "./server/tubular";
import * as dotenv from "dotenv";
dotenv.config();

async function run() {
  const apiKey = process.env.TUBULAR_API_KEY;
  if (!apiKey) {
    console.log("No API key");
    return;
  }
  // Use a known creator ID from Tubular, or just MrBeast's tubular ID (or any)
  // Let's just mock a call if we don't know the ID, but wait, the pipeline runs and fetches creators.
  // We can just log the db contents.
}
run();
