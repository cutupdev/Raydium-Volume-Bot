import { Logger } from 'pino';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

export const retrieveEnvVariable = (variableName: string, logger: Logger) => {
  const variable = process.env[variableName] || '';
  if (!variable) {
    logger.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};




export const randVal = (min: number, max: number, count: number, total: number, isEven: boolean): number[] => {

  const arr: number[] = Array(count).fill(total / count);
  if (isEven) return arr

  if (max * count < total)
    throw new Error("Invalid input: max * count must be greater than or equal to total.")
  if (min * count > total)
    throw new Error("Invalid input: min * count must be less than or equal to total.")
  const average = total / count
  // Generate initial array with all elements set to average value
  // Randomize pairs of elements
  for (let i = 0; i < count; i += 2) {
    // Generate a random adjustment within the range
    const adjustment = Math.random() * Math.min(max - average, average - min)
    // Add adjustment to one element and subtract from the other
    arr[i] += adjustment
    arr[i + 1] -= adjustment
  }
  // if (count % 2) arr.pop()
  return arr;
}


interface UserData {
  pubkey: string;
  privateKey: string;
  tokenBalance: number;
  solBalance: number;
}

export const saveDataToFile = (newData: UserData, filePath: string = "data.json") => {
  try {
      let existingData: UserData[] = [];

      // Check if the file exists
      if (fs.existsSync(filePath)) {
          // If the file exists, read its content
          const fileContent = fs.readFileSync(filePath, 'utf-8');
          existingData = JSON.parse(fileContent);
      }

      // Add the new data to the existing array
      existingData.push(newData);

      // Write the updated data back to the file
      fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2));

      console.log('Data saved to JSON file successfully.');
  } catch (error) {
      console.error('Error saving data to JSON file:', error);
  }
};

export const sleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}