import { SlashCommandBuilder } from "discord.js"

export const commands = [
  new SlashCommandBuilder()
    .setName("lobby")
    .setDescription("Open a new DnD lobby in this channel"),

  new SlashCommandBuilder()
    .setName("adjust-slots")
    .setDescription("Adjust player slot count (DM only)"),

  new SlashCommandBuilder()
    .setName("spawn-monster")
    .setDescription("Spawn monsters into combat (DM only)"),
]

export const commandsJSON = commands.map((c) => c.toJSON())
