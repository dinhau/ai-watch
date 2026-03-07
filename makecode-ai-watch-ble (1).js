// ============================================
// 會判斷光線好壞的 AI 手錶
// MakeCode JavaScript 完整版（BLE + USB）
// ============================================
// 📡 同時從藍牙和 USB 送出資料
// 🔵 BLE 協議：
//   D:光值,lux,狀態    → 每秒自動送
//   REC:1 / REC:0      → 開始/停止錄影
//   R:總秒,好秒,avgL,avgLux,avgSt → 閱讀結果
//   T:mm:ss            → 目前累計時間
// ============================================

// ===== 常數 =====
const THRESH_LOW = 190       // 低於此 = 太暗
const THRESH_HIGH = 230      // 高於此 = 太亮
const LUX_AT_LOW = 500       // 190 → 500 lux
const LUX_AT_HIGH = 1000     // 230 → 1000 lux
const LUX_SLOPE = (LUX_AT_HIGH - LUX_AT_LOW) / (THRESH_HIGH - THRESH_LOW)

const LONG_PRESS_MS = 800    // A 鍵長按門檻
const HIS_TIMEOUT_MS = 10000 // HIS 模式超時
const MAX_HISTORY = 10       // 最多儲存筆數
const SEND_INTERVAL_MS = 1000 // BLE 送出間隔

// ===== 全域變數 =====
let recording = false
let recTotalMs = 0
let recGoodMs = 0
let sumLightMs = 0
let sumLuxMs = 0
let lastSampleMs = 0

let hisMode = false
let hisLastActivity = 0
let hisIndex = 0

// 歷史紀錄：每筆 = [totalS, goodS, avgL, avgLux, avgSt]
let history: number[][] = []

// A 鍵狀態機
let aWasDown = false
let aPressStart = 0
let aLongFired = false

// B 鍵冷卻（防止誤觸）
let bCooldownUntil = 0

// BLE 定時送出
let lastSendMs = 0

// ===== 工具函式 =====

// 光值 → 估算 lux
function lightToLux(light: number): number {
    let lux = LUX_AT_LOW + (light - THRESH_LOW) * LUX_SLOPE
    return Math.max(0, lux)
}

// 判斷光線狀態：-1 太暗, 0 適合, 1 太亮
function lightState(light: number): number {
    if (light < THRESH_LOW) return -1
    if (light > THRESH_HIGH) return 1
    return 0
}

// 狀態 → LED 圖案
function stateIcon(st: number): IconNames {
    if (st === -1) return IconNames.Asleep    // 😴 太暗
    if (st === 0) return IconNames.Happy       // 🙂 適合
    return IconNames.Surprised                 // 😮 太亮
}

// 秒數 → mm:ss
function formatTime(totalS: number): string {
    let m = Math.floor(totalS / 60)
    let s = Math.floor(totalS % 60)
    let ms = (m < 10 ? "0" : "") + m
    let ss = (s < 10 ? "0" : "") + s
    return ms + ":" + ss
}

// 同時從 BLE + USB 送出
function sendBoth(msg: string) {
    bluetooth.uartWriteLine(msg)
    serial.writeLine(msg)
}

// 捲動文字
function showScroll(text: string) {
    basic.showString(text, 80)
}

// LED 閃爍動畫（取代音樂，節省記憶體）
function flashStart() {
    basic.showLeds(`
        . . # . .
        . # . # .
        # . . . #
        # # # # #
        . . . . .
    `)
    basic.pause(400)
}

function flashStop() {
    basic.showLeds(`
        # # # # #
        # . . . #
        # . . . #
        # . . . #
        # # # # #
    `)
    basic.pause(300)
}

// 閃爍狀態圖（顯示→消失→顯示）
function blinkIcon(st: number) {
    basic.showIcon(stateIcon(st))
    basic.pause(600)
    basic.clearScreen()
    basic.pause(400)
    basic.showIcon(stateIcon(st))
    basic.pause(600)
}

// ===== 顯示閱讀結果 =====
function showSessionResult(totalS: number, goodS: number, avgL: number, avgLux: number, avgSt: number) {
    showScroll("TOTAL:" + formatTime(totalS))
    showScroll("GOOD:" + formatTime(goodS))
    showScroll("AVG_L:" + Math.round(avgL))
    showScroll("AVG " + Math.round(avgLux) + "lx")
    blinkIcon(avgSt)
}

// ===== HIS 歷史模式 =====
function enterHisMode() {
    hisMode = true
    hisLastActivity = input.runningTime()
    hisIndex = 0
    showScroll("HIS")
}

function exitHisMode() {
    hisMode = false
    // 設定 B 鍵冷卻，防止退出時誤觸錄影
    bCooldownUntil = input.runningTime() + 1000
}

function showHistoryRecord(idx: number) {
    if (idx < 0 || idx >= history.length) {
        showScroll("NO DATA")
        return
    }
    let rec = history[idx]
    showScroll("#" + (idx + 1))
    showSessionResult(rec[0], rec[1], rec[2], rec[3], rec[4])
}

// ===== 錄影（閱讀計時）=====
function startRecording() {
    recording = true
    recTotalMs = 0
    recGoodMs = 0
    sumLightMs = 0
    sumLuxMs = 0
    lastSampleMs = input.runningTime()
    flashStart()
    sendBoth("REC:1")
}

function stopRecording() {
    recording = false
    bCooldownUntil = input.runningTime() + 1000

    let totalS = recTotalMs / 1000
    let goodS = recGoodMs / 1000
    let avgL = recTotalMs > 0 ? sumLightMs / recTotalMs : 0
    let avgLux = recTotalMs > 0 ? sumLuxMs / recTotalMs : 0
    let avgSt = lightState(Math.round(avgL))

    // 存入歷史
    if (history.length >= MAX_HISTORY) history.shift()
    history.push([totalS, goodS, avgL, avgLux, avgSt])

    // 送出結果
    sendBoth("REC:0")
    sendBoth("R:" + Math.round(totalS) + "," + Math.round(goodS) + "," + Math.round(avgL) + "," + Math.round(avgLux) + "," + avgSt)

    flashStop()
    showSessionResult(totalS, goodS, avgL, avgLux, avgSt)
}

function updateRecording() {
    let now = input.runningTime()
    let dt = now - lastSampleMs
    if (dt <= 0) return
    lastSampleMs = now

    let light = input.lightLevel()
    let lux = lightToLux(light)

    recTotalMs += dt
    if (light >= THRESH_LOW && light <= THRESH_HIGH) {
        recGoodMs += dt
    }
    sumLightMs += light * dt
    sumLuxMs += lux * dt
}

// ===== 藍牙設定 =====
bluetooth.startUartService()

bluetooth.onBluetoothConnected(function () {
    basic.showIcon(IconNames.Happy)
    basic.pause(300)
})

bluetooth.onBluetoothDisconnected(function () {
    basic.showIcon(IconNames.No)
    basic.pause(300)
})

// ===== 開機 =====
basic.showIcon(IconNames.Heart)
basic.pause(800)
basic.clearScreen()

// ===== 主迴圈 =====
basic.forever(function () {
    let now = input.runningTime()
    let light = input.lightLevel()
    let lux = lightToLux(light)
    let state = lightState(light)

    // --- 錄影中：持續更新數據 ---
    if (recording) {
        updateRecording()
    }

    // ===== A+B 同時按：快速顯示 TOTAL =====
    if (input.buttonIsPressed(Button.A) && input.buttonIsPressed(Button.B)) {
        if (recording) {
            let curTotal = recTotalMs / 1000
            showScroll("TOTAL:" + formatTime(curTotal))
            sendBoth("T:" + formatTime(curTotal))
        } else if (history.length > 0) {
            let last = history[history.length - 1]
            showScroll("TOTAL:" + formatTime(last[0]))
        } else {
            showScroll("NO DATA")
        }
        // 等放開
        while (input.buttonIsPressed(Button.A) || input.buttonIsPressed(Button.B)) {
            basic.pause(50)
        }
        basic.pause(200)
        return
    }

    // ===== A 鍵：長按/短按狀態機 =====
    if (input.buttonIsPressed(Button.A)) {
        if (!aWasDown) {
            aWasDown = true
            aPressStart = now
            aLongFired = false
        } else if (!aLongFired) {
            if (now - aPressStart >= LONG_PRESS_MS) {
                aLongFired = true
                if (!hisMode) {
                    enterHisMode()
                }
            }
        }
    } else {
        if (aWasDown) {
            if (!aLongFired) {
                // 短按 A
                if (hisMode) {
                    exitHisMode()
                } else {
                    // 顯示光值 + lux
                    showScroll("L=" + light)
                    showScroll("~" + Math.round(lux) + "lx")
                    sendBoth("D:" + light + "," + Math.round(lux) + "," + state)
                }
            }
            aWasDown = false
            aLongFired = false
        }
    }

    // ===== HIS 模式邏輯 =====
    if (hisMode) {
        // 超時退出
        if (now - hisLastActivity > HIS_TIMEOUT_MS) {
            exitHisMode()
            return
        }

        // B 鍵瀏覽歷史
        if (input.buttonIsPressed(Button.B)) {
            hisLastActivity = now
            if (history.length === 0) {
                showScroll("NO DATA")
            } else {
                if (hisIndex >= history.length) hisIndex = 0
                showHistoryRecord(hisIndex)
                hisIndex++
            }
            // 等放開
            while (input.buttonIsPressed(Button.B)) {
                basic.pause(50)
            }
            hisLastActivity = input.runningTime()
        }

        // 顯示 H 字母
        basic.showLeds(`
            # . . . #
            # . . . #
            # # # # #
            # . . . #
            # . . . #
        `)
        basic.pause(50)
        return
    }

    // ===== B 鍵：開始/停止錄影 =====
    if (input.buttonIsPressed(Button.B)) {
        // 冷卻中就跳過
        if (now < bCooldownUntil) {
            while (input.buttonIsPressed(Button.B)) {
                basic.pause(50)
            }
        } else {
            // 等放開再動作
            while (input.buttonIsPressed(Button.B)) {
                basic.pause(50)
            }
            basic.pause(100)
            if (recording) {
                stopRecording()
            } else {
                startRecording()
            }
        }
        return
    }

    // ===== 每秒自動送出即時資料 =====
    if (now - lastSendMs >= SEND_INTERVAL_MS) {
        lastSendMs = now
        let recFlag = recording ? 1 : 0
        sendBoth("D:" + light + "," + Math.round(lux) + "," + state)
    }

    // ===== 一般模式：顯示狀態圖案 =====
    basic.showIcon(stateIcon(state))
    basic.pause(50)
})
