import "dotenv/config"
import { REST, Routes } from "discord.js"
import { commandsJSON } from "./commands/index"

const token = process.env.DISCORD_TOKEN
const clientId = process.env.CLIENT_ID
const guildId = process.env.GUILD_ID

if (!token || !clientId) {
  console.error("❌ ต้องตั้งค่า DISCORD_TOKEN และ CLIENT_ID ใน .env")
  process.exit(1)
}

const rest = new REST({ version: "10" }).setToken(token)

;(async () => {
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId)

  await rest.put(route, { body: commandsJSON })
  console.log(`✅ Registered ${commandsJSON.length} slash commands${guildId ? ` (guild: ${guildId})` : " (global)"}`)
})().catch(console.error)
