import "dotenv/config"
import client from "./bot"
import { handleInteraction } from "./handlers/interactionHandler"

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`)
})

client.on("interactionCreate", async (interaction) => {
  await handleInteraction(interaction, client).catch(console.error)
})

const token = process.env.DISCORD_TOKEN
if (!token) {
  console.error("DISCORD_TOKEN is not set in .env")
  process.exit(1)
}

client.login(token)
