import OSC from "osc-js";

export type MixerFamily = "x32" | "x-air";

export class OSCClient {
    private osc: any;
    private host: string;
    private port: number;
    private responseCallbacks: Map<string, (value: any) => void> = new Map();
    private isConnected: boolean = false;
    private mixerFamily: MixerFamily | null = null;

    constructor(host: string, port: number) {
        this.host = host;
        this.port = port;

        // Create OSC instance with UDP plugin
        const plugin = new (OSC as any).DatagramPlugin({
            open: {
                host: "0.0.0.0",
                port: 0,
            },
            send: {
                host: this.host,
                port: this.port,
            },
        });

        this.osc = new (OSC as any)({
            plugin: plugin,
        });

        // Handle incoming OSC messages
        this.osc.on("*", (message: any) => {
            const address = message.address;
            const callback = this.responseCallbacks.get(address);

            if (callback && message.args && message.args.length > 0) {
                callback(message.args[0]);
                this.responseCallbacks.delete(address);
            }
        });

        this.osc.on("error", (err: Error) => {
            console.error("OSC Error:", err);
        });
    }

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("OSC socket open timeout"));
            }, 5000);

            this.osc.on("open", async () => {
                clearTimeout(timeout);
                this.isConnected = true;
                console.error("OSC UDP Port ready");

                try {
                    await this.detectMixerFamily();
                } catch (error) {
                    reject(error);
                    return;
                }

                // Subscribe to mixer updates (/xremote works on both X32 and X-Air)
                this.sendCommand("/xremote");

                // Keep connection alive with periodic /xremote messages
                setInterval(() => this.sendCommand("/xremote"), 9000);

                resolve();
            });

            try {
                this.osc.open({ port: 0 });
            } catch (error) {
                clearTimeout(timeout);
                reject(error);
            }
        });
    }

    private async detectMixerFamily(): Promise<void> {
        try {
            await this.sendAndReceiveWithTimeout("/xinfo", 500);
            this.mixerFamily = "x-air";
            console.error("Detected mixer family: X-Air");
            return;
        } catch {
            // Not X-Air, try X32
        }
        try {
            await this.sendAndReceiveWithTimeout("/info", 500);
            this.mixerFamily = "x32";
            console.error("Detected mixer family: X32/M32");
            return;
        } catch {
            // Neither responded
        }
        throw new Error(
            "Could not detect mixer family: /xinfo and /info did not respond. Check OSC_HOST and OSC_PORT."
        );
    }

    getMixerFamily(): MixerFamily | null {
        return this.mixerFamily;
    }

    private sendCommand(address: string, args?: any[]): void {
        if (!this.isConnected) {
            console.error("OSC not connected");
            return;
        }

        const message = new (OSC as any).Message(address, ...(args || []));
        this.osc.send(message);
    }

    private async sendAndReceive(address: string, args?: any[]): Promise<any> {
        return this.sendAndReceiveWithTimeout(address, 1000, args);
    }

    private async sendAndReceiveWithTimeout(
        address: string,
        timeoutMs: number,
        args?: any[]
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            this.responseCallbacks.set(address, resolve);
            this.sendCommand(address, args);

            setTimeout(() => {
                if (this.responseCallbacks.has(address)) {
                    this.responseCallbacks.delete(address);
                    reject(new Error(`Timeout waiting for response from ${address}`));
                }
            }, timeoutMs);
        });
    }

    /**
     * Returns the OSC path for the current mixer family, or null if the feature is unsupported on X-Air.
     */
    private translateAddress(x32Path: string, xAirPath?: string): string | null {
        if (this.mixerFamily === "x32") return x32Path;
        if (this.mixerFamily === "x-air") return xAirPath ?? null;
        return x32Path; // not yet detected, use X32 path (e.g. during very early connect)
    }

    private getChannelPath(channel: number): string {
        return `/ch/${channel.toString().padStart(2, "0")}`;
    }

    private getBusPath(bus: number): string {
        // X-Air uses unpadded bus index (/bus/1); X32 uses /bus/01
        if (this.mixerFamily === "x-air") return `/bus/${bus}`;
        return `/bus/${bus.toString().padStart(2, "0")}`;
    }

    private getAuxPath(aux: number): string {
        return `/aux/${aux.toString().padStart(2, "0")}`;
    }

    // ========== Channel Controls ==========

    async setFader(channel: number, level: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/fader`;
        this.sendCommand(path, [level]);
    }

    async getFader(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/mix/fader`;
        return await this.sendAndReceive(path);
    }

    async muteChannel(channel: number, mute: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/on`;
        // Mixer uses 1 for ON (unmuted) and 0 for OFF (muted)
        this.sendCommand(path, [mute ? 0 : 1]);
    }

    async getMute(channel: number): Promise<boolean> {
        const path = `${this.getChannelPath(channel)}/mix/on`;
        const value = await this.sendAndReceive(path);
        return value === 0;
    }

    async setPan(channel: number, pan: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/pan`;
        // Convert -1 to 1 range to 0 to 1 range (0 = left, 0.5 = center, 1 = right)
        const mixerPan = (pan + 1) / 2;
        this.sendCommand(path, [mixerPan]);
    }

    async getPan(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/mix/pan`;
        const value = await this.sendAndReceive(path);
        // Convert 0-1 range to -1 to 1 range
        return value * 2 - 1;
    }

    async setChannelName(channel: number, name: string): Promise<void> {
        const path = `${this.getChannelPath(channel)}/config/name`;
        this.sendCommand(path, [name]);
    }

    async getChannelName(channel: number): Promise<string> {
        const path = `${this.getChannelPath(channel)}/config/name`;
        return await this.sendAndReceive(path);
    }

    async setChannelColor(channel: number, color: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/config/color`;
        this.sendCommand(path, [color]);
    }

    // ========== EQ Controls ==========

    async setEQ(channel: number, band: number, gain: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/g`;
        // Convert dB to mixer range (0.0 to 1.0, where 0.5 is 0dB)
        const mixerGain = (gain + 15) / 30; // -15dB to +15dB mapped to 0-1
        this.sendCommand(path, [mixerGain]);
    }

    async getEQ(channel: number, band: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/g`;
        const value = await this.sendAndReceive(path);
        // Convert mixer range to dB
        return value * 30 - 15;
    }

    async setEQFrequency(channel: number, band: number, frequency: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/f`;
        // X-Air expects 0.0-1.0 (log scale 20Hz-20kHz); X32 uses Hz directly
        const value =
            this.mixerFamily === "x-air"
                ? (Math.log10(Math.max(20, Math.min(20000, frequency))) - Math.log10(20)) /
                  (Math.log10(20000) - Math.log10(20))
                : frequency;
        this.sendCommand(path, [value]);
    }

    async setEQQ(channel: number, band: number, q: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/q`;
        this.sendCommand(path, [q]);
    }

    async setEQType(channel: number, band: number, type: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/type`;
        this.sendCommand(path, [type]);
    }

    async setEQOn(channel: number, on: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/on`;
        this.sendCommand(path, [on ? 1 : 0]);
    }

    // ========== Dynamics Controls ==========

    async setGate(channel: number, threshold: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/thr`;
        // Convert dB to mixer range
        const mixerThreshold = (threshold + 80) / 80; // -80dB to 0dB mapped to 0-1
        this.sendCommand(path, [mixerThreshold]);
    }

    async getGate(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/gate/thr`;
        const value = await this.sendAndReceive(path);
        return value * 80 - 80;
    }

    async setGateRange(channel: number, range: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/range`;
        this.sendCommand(path, [range]);
    }

    async setGateAttack(channel: number, attack: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/attack`;
        this.sendCommand(path, [attack]);
    }

    async setGateHold(channel: number, hold: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/hold`;
        this.sendCommand(path, [hold]);
    }

    async setGateRelease(channel: number, release: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/release`;
        this.sendCommand(path, [release]);
    }

    async setGateOn(channel: number, on: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/on`;
        this.sendCommand(path, [on ? 1 : 0]);
    }

    async setCompressor(
        channel: number,
        threshold: number,
        ratio: number
    ): Promise<void> {
        const thrPath = `${this.getChannelPath(channel)}/dyn/thr`;
        const ratioPath = `${this.getChannelPath(channel)}/dyn/ratio`;

        // Convert threshold dB to mixer range
        const mixerThreshold = (threshold + 60) / 60; // -60dB to 0dB mapped to 0-1
        this.sendCommand(thrPath, [mixerThreshold]);

        // Convert ratio to mixer range
        const mixerRatio = (ratio - 1) / 19; // 1:1 to 20:1 mapped to 0-1
        this.sendCommand(ratioPath, [mixerRatio]);
    }

    async setCompressorAttack(channel: number, attack: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/attack`;
        this.sendCommand(path, [attack]);
    }

    async setCompressorRelease(channel: number, release: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/release`;
        this.sendCommand(path, [release]);
    }

    async setCompressorKnee(channel: number, knee: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/knee`;
        this.sendCommand(path, [knee]);
    }

    async setCompressorGain(channel: number, gain: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/gain`;
        this.sendCommand(path, [gain]);
    }

    async setCompressorOn(channel: number, on: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/on`;
        this.sendCommand(path, [on ? 1 : 0]);
    }

    // ========== Bus Controls ==========

    async setBusFader(bus: number, level: number): Promise<void> {
        const path = `${this.getBusPath(bus)}/mix/fader`;
        this.sendCommand(path, [level]);
    }

    async getBusFader(bus: number): Promise<number> {
        const path = `${this.getBusPath(bus)}/mix/fader`;
        return await this.sendAndReceive(path);
    }

    async muteBus(bus: number, mute: boolean): Promise<void> {
        const path = `${this.getBusPath(bus)}/mix/on`;
        this.sendCommand(path, [mute ? 0 : 1]);
    }

    async setBusPan(bus: number, pan: number): Promise<void> {
        const path = `${this.getBusPath(bus)}/mix/pan`;
        const mixerPan = (pan + 1) / 2;
        this.sendCommand(path, [mixerPan]);
    }

    async setBusName(bus: number, name: string): Promise<void> {
        const path = `${this.getBusPath(bus)}/config/name`;
        this.sendCommand(path, [name]);
    }

    // ========== Aux Controls ==========
    // X-Air uses /rtn/aux/ and /fxsend/N/; topology differs. No-op on X-Air for transparency.

    async setAuxFader(aux: number, level: number): Promise<void> {
        if (this.mixerFamily === "x-air") return;
        const path = `${this.getAuxPath(aux)}/mix/fader`;
        this.sendCommand(path, [level]);
    }

    async getAuxFader(aux: number): Promise<number> {
        if (this.mixerFamily === "x-air") return 0.75;
        const path = `${this.getAuxPath(aux)}/mix/fader`;
        return await this.sendAndReceive(path);
    }

    async muteAux(aux: number, mute: boolean): Promise<void> {
        if (this.mixerFamily === "x-air") return;
        const path = `${this.getAuxPath(aux)}/mix/on`;
        this.sendCommand(path, [mute ? 0 : 1]);
    }

    async setAuxPan(aux: number, pan: number): Promise<void> {
        if (this.mixerFamily === "x-air") return;
        const path = `${this.getAuxPath(aux)}/mix/pan`;
        const mixerPan = (pan + 1) / 2;
        this.sendCommand(path, [mixerPan]);
    }

    // ========== Sends ==========

    async sendToBus(channel: number, bus: number, level: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/${bus.toString().padStart(2, "0")}/level`;
        this.sendCommand(path, [level]);
    }

    async getSendToBus(channel: number, bus: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/mix/${bus.toString().padStart(2, "0")}/level`;
        return await this.sendAndReceive(path);
    }

    async sendToAux(channel: number, aux: number, level: number): Promise<void> {
        if (this.mixerFamily === "x-air") return;
        const path = `${this.getChannelPath(channel)}/mix/${(aux + 15).toString().padStart(2, "0")}/level`;
        this.sendCommand(path, [level]);
    }

    async setSendPrePost(channel: number, bus: number, pre: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/${bus.toString().padStart(2, "0")}/preamp`;
        this.sendCommand(path, [pre ? 1 : 0]);
    }

    // ========== Main Mix ==========

    async setMainFader(level: number): Promise<void> {
        const path = this.translateAddress("/main/st/mix/fader", "/lr/mix/fader");
        if (path) this.sendCommand(path, [level]);
    }

    async getMainFader(): Promise<number> {
        const path = this.translateAddress("/main/st/mix/fader", "/lr/mix/fader");
        if (!path) return 0.75;
        return await this.sendAndReceive(path);
    }

    async muteMain(mute: boolean): Promise<void> {
        const path = this.translateAddress("/main/st/mix/on", "/lr/mix/on");
        if (path) this.sendCommand(path, [mute ? 0 : 1]);
    }

    async setMainPan(pan: number): Promise<void> {
        const path = this.translateAddress("/main/st/mix/pan", "/lr/mix/pan");
        if (!path) return;
        const mixerPan = (pan + 1) / 2;
        this.sendCommand(path, [mixerPan]);
    }

    // ========== Matrix ==========
    // Matrix outputs (/mtx/*) are not available on X-Air; no-op for that family.

    async setMatrixFader(matrix: number, level: number): Promise<void> {
        if (this.mixerFamily === "x-air") return;
        const path = `/mtx/${matrix.toString().padStart(2, "0")}/mix/fader`;
        this.sendCommand(path, [level]);
    }

    async muteMatrix(matrix: number, mute: boolean): Promise<void> {
        if (this.mixerFamily === "x-air") return;
        const path = `/mtx/${matrix.toString().padStart(2, "0")}/mix/on`;
        this.sendCommand(path, [mute ? 0 : 1]);
    }

    // ========== Effects ==========
    // X-Air uses /fx/1-4/insert (not /on) and unpadded effect index; X-Air has 4 FX slots.

    async setEffectOn(effect: number, on: boolean): Promise<void> {
        if (this.mixerFamily === "x-air") {
            if (effect < 1 || effect > 4) return;
            const path = `/fx/${effect}/insert`;
            this.sendCommand(path, [on ? 1 : 0]);
            return;
        }
        const path = `/fx/${effect.toString().padStart(2, "0")}/on`;
        this.sendCommand(path, [on ? 1 : 0]);
    }

    async setEffectMix(effect: number, mix: number): Promise<void> {
        const path =
            this.mixerFamily === "x-air"
                ? effect >= 1 && effect <= 4
                    ? `/fx/${effect}/mix`
                    : null
                : `/fx/${effect.toString().padStart(2, "0")}/mix`;
        if (path) this.sendCommand(path, [mix]);
    }

    async setEffectParam(effect: number, param: number, value: number): Promise<void> {
        const path =
            this.mixerFamily === "x-air"
                ? effect >= 1 && effect <= 4
                    ? `/fx/${effect}/par/${param.toString().padStart(2, "0")}`
                    : null
                : `/fx/${effect.toString().padStart(2, "0")}/par/${param.toString().padStart(2, "0")}`;
        if (path) this.sendCommand(path, [value]);
    }

    // ========== Routing ==========

    async setChannelSource(channel: number, source: number): Promise<void> {
        const path = this.translateAddress(
            `${this.getChannelPath(channel)}/config/source`,
            `${this.getChannelPath(channel)}/config/insrc`
        );
        if (!path) return;
        const value = this.mixerFamily === "x-air" ? Math.max(0, Math.min(15, source)) : source;
        this.sendCommand(path, [value]);
    }

    async getChannelSource(channel: number): Promise<number> {
        const path = this.translateAddress(
            `${this.getChannelPath(channel)}/config/source`,
            `${this.getChannelPath(channel)}/config/insrc`
        );
        if (!path) return 0;
        return await this.sendAndReceive(path);
    }

    // ========== Scenes ==========

    async recallScene(scene: number): Promise<void> {
        const path = `/-snap/load`;
        // X32 uses 0-based index; X-Air uses 1-64
        const arg = this.mixerFamily === "x-air" ? scene : scene - 1;
        this.sendCommand(path, [arg]);
    }

    async saveScene(scene: number, name?: string): Promise<void> {
        const path = this.translateAddress("/-snap/store", "/-snap/save");
        if (!path) return;
        const arg = this.mixerFamily === "x-air" ? scene : scene - 1;
        this.sendCommand(path, [arg]);
        if (name) {
            const namePath = this.translateAddress(
                `/-snap/${(scene - 1).toString().padStart(3, "0")}/name`,
                `/-snap/${(scene - 1).toString().padStart(2, "0")}/name/01`
            );
            if (namePath) this.sendCommand(namePath, [name]);
        }
    }

    async getSceneName(scene: number): Promise<string> {
        if (this.mixerFamily === "x-air") {
            // X-Air: name-by-index paths do not respond (verified). Only /-snap/name (current) works.
            // If the requested scene is the current snapshot, return its name; otherwise we cannot read it.
            try {
                const currentIndex = await this.sendAndReceive("/-snap/index");
                const current = typeof currentIndex === "number" ? currentIndex : Number(currentIndex);
                if (current === scene) {
                    return await this.sendAndReceive("/-snap/name");
                }
            } catch {
                // ignore
            }
            return "";
        }
        const path = `/-snap/${(scene - 1).toString().padStart(3, "0")}/name`;
        return await this.sendAndReceive(path);
    }

    // ========== Meters ==========

    async getChannelMeter(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/mix/fader`;
        // Note: Meters are typically sent automatically by the mixer
        // This is a placeholder - actual meter data comes via /meters
        return await this.sendAndReceive(path);
    }

    // ========== Status ==========

    async getMixerStatus(): Promise<any> {
        try {
            const infoAddress = this.mixerFamily === "x-air" ? "/xinfo" : "/info";
            const info = await this.sendAndReceive(infoAddress);

            return {
                connected: true,
                host: this.host,
                port: this.port,
                mixerFamily: this.mixerFamily,
                info,
            };
        } catch (error) {
            return {
                connected: false,
                host: this.host,
                port: this.port,
                mixerFamily: this.mixerFamily,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    // ========== Custom Commands ==========

    async sendCustomCommand(address: string, value?: any): Promise<void> {
        if (value === undefined) {
            this.sendCommand(address);
        } else {
            // osc-js automatically handles type conversion
            this.sendCommand(address, Array.isArray(value) ? value : [value]);
        }
    }

    close(): void {
        this.isConnected = false;
        this.osc.close();
    }
}
