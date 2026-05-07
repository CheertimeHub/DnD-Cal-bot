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

  new SlashCommandBuilder()
    .setName("end-session")
    .setDescription("End the current session (DM only)"),

  new SlashCommandBuilder()
    .setName("monster-roll")
    .setDescription("Set monster roll mode (DM only)")
    .addStringOption((opt) =>
      opt.setName("mode").setDescription("auto or manual").setRequired(true)
        .addChoices(
          { name: "Auto (บอท roll ให้)", value: "auto" },
          { name: "Manual (DM ทอยเอง)", value: "manual" }
        )
    ),
]

export const commandsJSON = commands.map((c) => c.toJSON())
