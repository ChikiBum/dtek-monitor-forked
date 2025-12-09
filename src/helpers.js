import fs from "node:fs"
import path from "node:path"

import { LAST_MESSAGE_FILE } from "./constants.js"

export function capitalize(str) {
  if (typeof str !== "string") return ""
  return str[0].toUpperCase() + str.slice(1).toLowerCase()
}

export function loadLastMessage(chatId = null) {
  // Якщо передано chatId, користуємо окремий файл для кожного чату
  const fileName = chatId ? `last-message-${chatId}.json` : "last-message.json"
  const filePath = path.join(path.dirname(LAST_MESSAGE_FILE), fileName)

  if (!fs.existsSync(filePath)) return null

  const lastMessage = JSON.parse(
    fs.readFileSync(filePath, "utf8").trim()
  )

  if (lastMessage?.date) {
    const messageDay = new Date(lastMessage.date * 1000).toLocaleDateString(
      "en-CA",
      { timeZone: "Europe/Kyiv" }
    )
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Europe/Kyiv",
    })

    if (messageDay < today) {
      deleteLastMessage(chatId)
      return null
    }
  }

  return lastMessage
}

export function saveLastMessage({ date, message_id } = {}, chatId = null) {
  // Якщо передано chatId, зберігаємо окремо для кожного чату
  const fileName = chatId ? `last-message-${chatId}.json` : "last-message.json"
  const filePath = path.join(path.dirname(LAST_MESSAGE_FILE), fileName)

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      message_id,
      date,
    })
  )
}

export function deleteLastMessage(chatId = null) {
  // Якщо передано chatId, видаляємо окремо для кожного чату
  const fileName = chatId ? `last-message-${chatId}.json` : "last-message.json"
  const filePath = path.join(path.dirname(LAST_MESSAGE_FILE), fileName)

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}

export function getCurrentTime() {
  const now = new Date()

  const date = now.toLocaleDateString("uk-UA", {
    timeZone: "Europe/Kyiv",
  })

  const time = now.toLocaleTimeString("uk-UA", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit",
    minute: "2-digit",
  })

  return `${time} ${date}`
}
