#!/usr/bin/env node
/**
 * OSC address verification script for the plan's Verification Step.
 * Connects to a mixer (X-Air or X32), sends query messages, and records
 * which addresses respond. Usage:
 *   node scripts/verify-osc.mjs [host] [port]
 *   OSC_HOST=192.168.8.150 OSC_PORT=10024 node scripts/verify-osc.mjs
 */

import OSC from "osc-js";
import { writeFileSync } from "fs";

const HOST = process.env.OSC_HOST || process.argv[2] || "192.168.8.150";
const PORT = parseInt(process.env.OSC_PORT || process.argv[3] || "10024", 10);
const TIMEOUT_MS = 800;

const CHECKLIST = [
    { category: "Info", x32Path: "/info", xAirPath: "/xinfo", note: "Detects family" },
    { category: "Main fader", x32Path: "/main/st/mix/fader", xAirPath: "/lr/mix/fader", note: "" },
    { category: "Main mute", x32Path: "/main/st/mix/on", xAirPath: "/lr/mix/on", note: "" },
    { category: "Main pan", x32Path: "/main/st/mix/pan", xAirPath: "/lr/mix/pan", note: "" },
    { category: "Channel fader", x32Path: "/ch/01/mix/fader", xAirPath: "/ch/01/mix/fader", note: "Same path?" },
    { category: "Channel mute", x32Path: "/ch/01/mix/on", xAirPath: "/ch/01/mix/on", note: "" },
    { category: "Channel pan", x32Path: "/ch/01/mix/pan", xAirPath: "/ch/01/mix/pan", note: "Value format?" },
    { category: "Channel source (X32)", x32Path: "/ch/01/config/source", xAirPath: null, note: "X32 only" },
    { category: "Channel source (X-Air)", x32Path: null, xAirPath: "/ch/01/config/insrc", note: "X-Air only" },
    { category: "Bus fader (01)", x32Path: "/bus/01/mix/fader", xAirPath: "/bus/01/mix/fader", note: "" },
    { category: "Bus fader (1)", x32Path: "/bus/1/mix/fader", xAirPath: "/bus/1/mix/fader", note: "Index format" },
    { category: "Aux fader", x32Path: "/aux/01/mix/fader", xAirPath: null, note: "Expect no response on X-Air" },
    { category: "Matrix fader", x32Path: "/mtx/01/mix/fader", xAirPath: null, note: "Expect no response on X-Air" },
    { category: "FX on (01)", x32Path: "/fx/01/on", xAirPath: "/fx/01/on", note: "" },
    { category: "FX on (1)", x32Path: "/fx/1/on", xAirPath: "/fx/1/on", note: "Index format" },
    { category: "Scene load", x32Path: "/-snap/load", xAirPath: "/-snap/load", note: "Query only" },
    { category: "Scene name (000)", x32Path: "/-snap/000/name", xAirPath: null, note: "X32 style" },
    { category: "Scene name (01/01)", x32Path: null, xAirPath: "/-snap/01/name/01", note: "X-Air doc" },
    { category: "Scene name (current)", x32Path: null, xAirPath: "/-snap/name", note: "X-Air current" },
    { category: "Send to aux 16", x32Path: "/ch/01/mix/16/level", xAirPath: null, note: "X32 aux send" },
];

function createOSCClient(host, port) {
    const plugin = new OSC.DatagramPlugin({
        open: { host: "0.0.0.0", port: 0 },
        send: { host, port },
    });
    const osc = new OSC({ plugin });
    return osc;
}

const pending = new Map();

function sendAndReceive(osc, address, timeoutMs = TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(address);
            reject(new Error("timeout"));
        }, timeoutMs);
        pending.set(address, { resolve, reject, timer });
        const msg = new OSC.Message(address);
        osc.send(msg);
    });
}

/** Send a message with a value (no response expected). */
function sendOnly(osc, address, value) {
    const msg = new OSC.Message(address, value);
    osc.send(msg);
}


function installMessageHandler(osc) {
    osc.on("*", (message) => {
        const addr = message.address;
        const value = message.args && message.args.length > 0 ? message.args[0] : null;
        for (const [address, entry] of pending.entries()) {
            if (addr === address || addr.startsWith(address.replace(/\/$/, "") + "/")) {
                clearTimeout(entry.timer);
                pending.delete(address);
                entry.resolve(value);
                return;
            }
        }
    });
}

async function detectFamily(osc) {
    try {
        await sendAndReceive(osc, "/xinfo", 500);
        return "x-air";
    } catch {
        try {
            await sendAndReceive(osc, "/info", 500);
            return "x32";
        } catch {
            return null;
        }
    }
}

async function runVerification() {
    const osc = createOSCClient(HOST, PORT);
    const results = [];
    const start = Date.now();

    return new Promise((resolve, reject) => {
        osc.on("open", async () => {
            installMessageHandler(osc);
            console.log(`\nConnected to ${HOST}:${PORT}. Detecting mixer family...\n`);
            let family;
            try {
                family = await detectFamily(osc);
            } catch (e) {
                reject(e);
                return;
            }
            if (!family) {
                reject(new Error("Could not detect mixer: /xinfo and /info did not respond."));
                return;
            }
            console.log(`Detected: ${family.toUpperCase()}\n`);
            results.push({ test: "Family detection", result: "OK", value: family, note: "" });

            const addressesToTest = family === "x-air"
                ? CHECKLIST.filter((r) => r.xAirPath).map((r) => ({ ...r, path: r.xAirPath }))
                : CHECKLIST.filter((r) => r.x32Path).map((r) => ({ ...r, path: r.x32Path }));

            for (const row of addressesToTest) {
                const path = row.path;
                let result = "TIMEOUT";
                let value = null;
                try {
                    value = await sendAndReceive(osc, path);
                    result = "OK";
                } catch (e) {
                    if (e.message === "timeout") result = "TIMEOUT";
                    else result = `ERROR: ${e.message}`;
                }
                const valueStr = value !== null && value !== undefined ? String(value) : "";
                results.push({
                    category: row.category,
                    path,
                    result,
                    value: valueStr,
                    note: row.note || "",
                });
                const icon = result === "OK" ? "✓" : "✗";
                console.log(`${icon} ${path} → ${result}${valueStr ? ` (${valueStr})` : ""}`);
            }

            // X-Air Snapshots: compare MCP support vs wiki (/-snap/load, save, name, index, name by index).
            if (family === "x-air") {
                console.log("\n--- Snapshot (X-Air wiki) ---");
                const snapTests = [
                    { category: "Snap index (current)", path: "/-snap/index", note: "Doc: 1-64 list index" },
                    { category: "Snap name (current)", path: "/-snap/name", note: "Doc: current name" },
                    { category: "Snap name by idx 0/01", path: "/-snap/0/name/01", note: "0-indexed slot 0" },
                    { category: "Snap name by idx 00/01", path: "/-snap/00/name/01", note: "00 = first" },
                    { category: "Snap name by idx 1/01", path: "/-snap/1/name/01", note: "1-based slot 1" },
                    { category: "Snap name by idx 01/01", path: "/-snap/01/name/01", note: "Doc: Snapshot [0..63] name" },
                ];
                for (const row of snapTests) {
                    let result = "TIMEOUT";
                    let value = null;
                    try {
                        value = await sendAndReceive(osc, row.path);
                        result = "OK";
                    } catch (e) {
                        if (e.message === "timeout") result = "TIMEOUT";
                        else result = `ERROR: ${e.message}`;
                    }
                    const valueStr = value !== null && value !== undefined ? String(value).slice(0, 25) : "";
                    results.push({ category: row.category, path: row.path, result, value: valueStr, note: row.note });
                    const icon = result === "OK" ? "✓" : "✗";
                    console.log(`${icon} ${row.path} → ${result}${valueStr ? ` (${valueStr})` : ""}`);
                }
                // Flow: load scene 2, then read index and name (MCP recallScene + getSceneName pattern).
                console.log("\n  Flow: load scene 2 then query index and name...");
                let idxBefore = null;
                let nameBefore = null;
                try {
                    idxBefore = await sendAndReceive(osc, "/-snap/index");
                    nameBefore = await sendAndReceive(osc, "/-snap/name");
                } catch {
                    // ignore
                }
                sendOnly(osc, "/-snap/load", 2);
                await new Promise((r) => setTimeout(r, 250));
                let idxAfter = null;
                let nameAfter = null;
                try {
                    idxAfter = await sendAndReceive(osc, "/-snap/index", 600);
                    nameAfter = await sendAndReceive(osc, "/-snap/name", 600);
                } catch {
                    // ignore
                }
                if (idxBefore !== null) sendOnly(osc, "/-snap/load", idxBefore);
                results.push({
                    category: "Snap flow load(2)→index",
                    path: "/-snap/load",
                    result: idxAfter === 2 || idxAfter === 2.0 ? "OK" : idxAfter != null ? `got ${idxAfter}` : "TIMEOUT",
                    value: String(idxAfter ?? ""),
                    note: "After load 2, query index",
                });
                results.push({
                    category: "Snap flow load(2)→name",
                    path: "/-snap/name",
                    result: nameAfter != null && nameAfter !== nameBefore ? "OK" : nameAfter != null ? "same" : "TIMEOUT",
                    value: String(nameAfter ?? "").slice(0, 25),
                    note: "After load 2, query name",
                });
                console.log(`  → index after load(2): ${idxAfter ?? "timeout"}, name: ${nameAfter ?? "timeout"}\n`);
            }

            // X-Air FX: doc uses /fx/1/insert (not /fx/1/on). Test query + set-then-get.
            if (family === "x-air") {
                const fxTests = [
                    { category: "FX insert (X-Air doc)", path: "/fx/1/insert", note: "Effect on/off = insert" },
                    { category: "FX type (X-Air doc)", path: "/fx/1/type", note: "Effect type" },
                ];
                for (const row of fxTests) {
                    let result = "TIMEOUT";
                    let value = null;
                    try {
                        value = await sendAndReceive(osc, row.path);
                        result = "OK";
                    } catch (e) {
                        if (e.message === "timeout") result = "TIMEOUT";
                        else result = `ERROR: ${e.message}`;
                    }
                    const valueStr = value !== null && value !== undefined ? String(value) : "";
                    results.push({ category: row.category, path: row.path, result, value: valueStr, note: row.note });
                    const icon = result === "OK" ? "✓" : "✗";
                    console.log(`${icon} ${row.path} → ${result}${valueStr ? ` (${valueStr})` : ""}`);
                }
                // Set-then-get: some mixers only echo after a write
                console.log("\n  Set-then-get: set /fx/1/insert=1 then query...");
                const before = await sendAndReceive(osc, "/fx/1/insert").catch(() => null);
                sendOnly(osc, "/fx/1/insert", 1);
                await new Promise((r) => setTimeout(r, 150));
                let after = null;
                try {
                    after = await sendAndReceive(osc, "/fx/1/insert", 600);
                } catch {
                    // ignore
                }
                if (before !== null) sendOnly(osc, "/fx/1/insert", before);
                else sendOnly(osc, "/fx/1/insert", 0);
                const setGetResult = after === 1 || after === 1.0 ? "OK (set-then-get)" : after !== null ? `OK (echoed ${after})` : "TIMEOUT";
                results.push({
                    category: "FX insert set-then-get",
                    path: "/fx/1/insert",
                    result: setGetResult,
                    value: String(after ?? ""),
                    note: "Write 1 then query; restore previous",
                });
                console.log(`  → ${setGetResult}\n`);
            }

            osc.close();
            const logPath = "verification-log.md";
            const duration = ((Date.now() - start) / 1000).toFixed(1);
            const body = [
                `# OSC Verification Log`,
                ``,
                `- **Target**: ${HOST}:${PORT}`,
                `- **Detected family**: ${family}`,
                `- **Date**: ${new Date().toISOString()}`,
                `- **Duration**: ${duration}s`,
                ``,
                `## Results`,
                ``,
                `| Category | Path | Result | Value | Notes |`,
                `|----------|------|--------|-------|-------|`,
                ...results.map((r) =>
                    `| ${r.category || r.test || ""} | ${r.path || "-"} | ${r.result} | ${(r.value ?? "").toString().slice(0, 20)} | ${r.note || ""} |`
                ),
            ].join("\n");
            writeFileSync(logPath, body, "utf8");
            console.log(`\nVerification log written to ${logPath}`);
            resolve({ family, results, logPath });
        });

        osc.on("error", (err) => reject(err));
        osc.open({ port: 0 });
    });
}

runVerification().then(
    (out) => {
        console.log("\nDone.");
        process.exit(0);
    },
    (err) => {
        console.error("Verification failed:", err.message);
        process.exit(1);
    }
);
