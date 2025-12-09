import { chromium } from "playwright"

import {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  CITY,
  STREET,
  HOUSE,
  SHUTDOWNS_PAGE,
} from "./constants.js"

import {
  capitalize,
  deleteLastMessage,
  getCurrentTime,
  loadLastMessage,
  saveLastMessage,
} from "./helpers.js"

async function getInfo() {
  console.log("🌀 Getting info...")

  const browser = await chromium.launch({ headless: true })
  const browserPage = await browser.newPage()

  try {
    await browserPage.goto(SHUTDOWNS_PAGE, {
      waitUntil: "load",
    })

    const csrfTokenTag = await browserPage.waitForSelector(
      'meta[name="csrf-token"]',
      { state: "attached" }
    )
    const csrfToken = await csrfTokenTag.getAttribute("content")

    const info = await browserPage.evaluate(
      async ({ CITY, STREET, csrfToken }) => {
        const formData = new URLSearchParams()
        formData.append("method", "getHomeNum")
        formData.append("data[0][name]", "city")
        formData.append("data[0][value]", CITY)
        formData.append("data[1][name]", "street")
        formData.append("data[1][value]", STREET)
        formData.append("data[2][name]", "updateFact")
        formData.append("data[2][value]", new Date().toLocaleString("uk-UA"))

        const response = await fetch("/ua/ajax", {
          method: "POST",
          headers: {
            "x-requested-with": "XMLHttpRequest",
            "x-csrf-token": csrfToken,
          },
          body: formData,
        })
        return await response.json()
      },
      { CITY, STREET, csrfToken }
    )

    console.log("✅ Getting info finished.")
    return info
  } catch (error) {
    throw Error(`❌ Getting info failed: ${error.message}`)
  } finally {
    await browser.close()
  }
}

function parseScheduleIntervals(response, scheduleId = "GPV5.1") {
  if (!response || !response.fact || !response.fact.today) {
    return [];
  }
  const todayKey = String(response.fact.today);
  const dayData = response.fact.data && response.fact.data[todayKey];
  if (!dayData || !dayData[scheduleId]) {
    return [];
  }

  const hourMap = dayData[scheduleId]; // keys "1".."24"
  // 48 півгодинних слотів, починаючи з 00:00
  const slots = new Array(48).fill("on"); // values: 'on'|'off'|'possible'|'unknown'

  const markHalf = (hourIndex, half, value) => {
    // hourIndex 1..24, half 0|1
    const slotIndex = (hourIndex - 1) * 2 + half;
    slots[slotIndex] = value;
  };

  const mapValueToSlots = (hourIndex, val) => {
    switch ((val || "").toString()) {
      case "no":
        markHalf(hourIndex, 0, "off");
        markHalf(hourIndex, 1, "off");
        break;
      case "yes":
        markHalf(hourIndex, 0, "on");
        markHalf(hourIndex, 1, "on");
        break;
      case "first":
        markHalf(hourIndex, 0, "off");
        markHalf(hourIndex, 1, "on");
        break;
      case "second":
        markHalf(hourIndex, 0, "on");
        markHalf(hourIndex, 1, "off");
        break;
      case "maybe":
        markHalf(hourIndex, 0, "possible");
        markHalf(hourIndex, 1, "possible");
        break;
      case "mfirst":
        markHalf(hourIndex, 0, "possible");
        markHalf(hourIndex, 1, "on");
        break;
      case "msecond":
        markHalf(hourIndex, 0, "on");
        markHalf(hourIndex, 1, "possible");
        break;
      default:
        markHalf(hourIndex, 0, "unknown");
        markHalf(hourIndex, 1, "unknown");
    }
  };

  for (let h = 1; h <= 24; h++) {
    const val = hourMap[String(h)];
    mapValueToSlots(h, val);
  }

  // Функція для форматування слота у час "HH:MM"
  const fmt = (slotIndex) => {
    if (slotIndex < 0) slotIndex = 0;
    if (slotIndex > 48) slotIndex = 48;
    const hour = Math.floor(slotIndex / 2);
    const minute = slotIndex % 2 === 0 ? "00" : "30";
    return `${String(hour).padStart(2, "0")}:${minute}`;
  };

  // Збираємо інтервали для 'off'
  const intervals = [];
  let i = 0;
  while (i < 48) {
    if (slots[i] === "off") {
      let start = i;
      let j = i + 1;
      while (j < 48 && slots[j] === "off") j++;
      intervals.push({ start: fmt(start), end: fmt(j), type: "off" });
      i = j;
      continue;
    }
    i++;
  }

  // Також додаємо 'possible' інтервали
  i = 0;
  while (i < 48) {
    if (slots[i] === "possible") {
      let start = i;
      let j = i + 1;
      while (j < 48 && slots[j] === "possible") j++;
      intervals.push({ start: fmt(start), end: fmt(j), type: "possible" });
      i = j;
      continue;
    }
    i++;
  }

  // Сортуємо інтервали по часу початку
  intervals.sort((a, b) => (a.start > b.start ? 1 : a.start < b.start ? -1 : 0));
  return intervals;
}

function formatScheduleIntervals(intervals, hasData = true) {
  if (!hasData) {
    return "⏳ Дані на наступний день будуть доступні пізніше"
  }

  if (!intervals || intervals.length === 0) {
    return "✅ Відключень не заплановано"
  }

  const offIntervals = intervals.filter(i => i.type === "off")
  const possibleIntervals = intervals.filter(i => i.type === "possible")

  let result = ""

  if (offIntervals.length > 0) {
    result += offIntervals.map(i => `🪫 ${i.start} — ${i.end}`).join("\n")
  }

  if (possibleIntervals.length > 0) {
    if (result) result += "\n"
    result += possibleIntervals.map(i => `❓ ${i.start} — ${i.end} (можливо)`).join("\n")
  }

  return result || "✅ Відключень не заплановано"
}

function parseFactualOutages(info, house) {
  // Парсимо фактичні відключення з поля 'fact'
  const fact = info?.fact?.data || {}
  const outages = []

  // fact містить timestamp як ключ, в кожному timestamp об'єкт з чергами
  // Для тепер повертаємо порожній масив (структуру понадобиться обговорити)

  return outages
}

function formatFactualOutages(outages) {
  if (!outages || outages.length === 0) {
    return "✅ Фактичних відключень немає"
  }

  return outages
    .slice(0, 5) // Показуємо останні 5
    .map(outage => {
      const icon = outage.type.toLowerCase().includes("аварійне") ? "⚠️" :
        outage.type.toLowerCase().includes("гарантоване") ? "🪫" :
          "📅"
      return `${icon} <b>${outage.date}</b> ${outage.from} — ${outage.to}\n   <i>${outage.type}</i>`
    })
    .join("\n")
}

function getQueueFromGraph(info) {
  const houseData = info?.data?.[HOUSE]
  if (!houseData?.sub_type_reason || houseData.sub_type_reason.length === 0) {
    return "Невідомо"
  }
  return houseData.sub_type_reason.join(", ")
} function generateMessage(info) {
  console.log("🌀 Generating message...")

  if (!info?.data) {
    throw Error("❌ Power outage info missed.")
  }

  const queue = getQueueFromGraph(info)
  const address = `${CITY}, ${STREET}, ${HOUSE}`

  // Парсимо графік відключень для сьогодні
  const todayIntervals = parseScheduleIntervals(info, queue)

  // Парсимо графік для завтра
  const tomorrowKey = info.fact?.today ? String(Number(info.fact.today) + 86400) : null
  const tomorrowData = tomorrowKey && info.fact?.data?.[tomorrowKey]
  const hasTomorrowData = !!tomorrowData

  let tomorrowIntervals = []
  if (hasTomorrowData && tomorrowData[queue]) {
    const tomorrowResponse = {
      fact: {
        today: Number(tomorrowKey),
        data: {
          [tomorrowKey]: { [queue]: tomorrowData[queue] }
        }
      }
    }
    tomorrowIntervals = parseScheduleIntervals(tomorrowResponse, queue)
  }

  const updateTime = getCurrentTime()

  // Форматуємо дати
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const formatDate = (date) => {
    const day = String(date.getDate()).padStart(2, "0")
    const month = String(date.getMonth() + 1).padStart(2, "0")
    return `${day}.${month}`
  }

  const separator = "═".repeat(50)

  let tomorrowText = ""
  if (hasTomorrowData) {
    tomorrowText = formatScheduleIntervals(tomorrowIntervals)
  } else {
    tomorrowText = "⏳ Графік на завтра ще не доступний (зазвичай з'являється ввечері)"
  }

  const message = [
    `⚡️ <b>Статус електропостачання</b>`,
    `🏠 <b>Адреса:</b> ${address}`,
    `🔢 <b>Черга:</b> ${queue}`,
    ``,
    separator,
    ``,
    `📅 <b>Графік на сьогодні (${formatDate(today)}):</b>`,
    ``,
    formatScheduleIntervals(todayIntervals),
    ``,
    separator,
    ``,
    `📅 <b>Графік на завтра (${formatDate(tomorrow)}):</b>`,
    ``,
    tomorrowText,
    ``,
    separator,
    ``,
    `🕐 <i>Оновлено: ${updateTime}</i>`,
  ].filter(line => line !== null && line !== "").join("\n")

  console.log("✉️ Message generated successfully")
  return message
}

async function sendNotification(message) {
  if (!TELEGRAM_BOT_TOKEN)
    throw Error("❌ Missing telegram bot token or chat id.")
  if (!TELEGRAM_CHAT_ID) throw Error("❌ Missing telegram chat id.")

  console.log("🌀 Sending notification...")
  console.log("📨 Message length:", message.length)

  const lastMessage = loadLastMessage() || {}
  try {
    const endpoint = lastMessage.message_id ? "editMessageText" : "sendMessage"
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`

    console.log(`📤 Using endpoint: ${endpoint}`)
    console.log(`💬 Chat ID: ${TELEGRAM_CHAT_ID}`)

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
        message_id: lastMessage.message_id ?? undefined,
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      console.error("🔴 Telegram API error:", data)
      throw new Error(`Telegram API error: ${data.description}`)
    }

    if (data.ok && data.result) {
      saveLastMessage(data.result)
      console.log("🟢 Notification sent successfully!")
      console.log("✉️ Message ID:", data.result.message_id)
    } else {
      console.error("🔴 Unexpected response:", data)
      throw new Error("Unexpected Telegram API response")
    }
  } catch (error) {
    console.error("🔴 Notification not sent:", error.message)
    deleteLastMessage()
    throw error
  }
}

async function run() {
  try {
    console.log("🚀 Starting DTEK Monitor...")
    const info = await getInfo()

    console.log("📊 Info received successfully")
    console.log("🔍 Queue:", info.data?.[HOUSE]?.sub_type_reason?.[0] || "Unknown")

    const message = generateMessage(info)
    console.log("✉️ Message generated successfully")

    console.log("\n" + "=".repeat(50))
    console.log("📨 Повідомлення для відправки:")
    console.log("=".repeat(50))
    console.log(message.replace(/<\/?[^>]+(>|$)/g, "")) // Прибираємо HTML теги для консолі
    console.log("=".repeat(50) + "\n")

    await sendNotification(message)
    console.log("✅ Script completed successfully!")
  } catch (error) {
    console.error("❌ Error occurred:", error.message)
    console.error("Stack trace:", error.stack)
    process.exit(1)
  }
}

run().catch((error) => console.error(error.message))
