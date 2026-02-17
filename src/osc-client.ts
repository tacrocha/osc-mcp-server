import OSC from "osc-js";

export class OSCClient {
    private osc: any;
    private host: string;
    private port: number;
    private responseCallbacks: Map<string, (value: any) => void> = new Map();
    private isConnected: boolean = false;

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
                    await this.verifyXAir();
                } catch (error) {
                    reject(error);
                    return;
                }

                this.sendCommand("/xremote");
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

    private async verifyXAir(): Promise<void> {
        try {
            await this.sendAndReceiveWithTimeout("/xinfo", 500);
            console.error("X-Air mixer verified");
        } catch {
            throw new Error(
                "X-Air mixer did not respond to /xinfo. Check OSC_HOST and OSC_PORT (default 10024)."
            );
        }
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

    private getChannelPath(channel: number): string {
        return `/ch/${channel.toString().padStart(2, "0")}`;
    }

    private getBusPath(bus: number): string {
        return `/bus/${bus}`;
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
        this.sendCommand(path, [mute ? 0 : 1]);
    }

    async getMute(channel: number): Promise<boolean> {
        const path = `${this.getChannelPath(channel)}/mix/on`;
        const value = await this.sendAndReceive(path);
        return value === 0;
    }

    async setPan(channel: number, pan: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/pan`;
        const mixerPan = (pan + 1) / 2;
        this.sendCommand(path, [mixerPan]);
    }

    async getPan(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/mix/pan`;
        const value = await this.sendAndReceive(path);
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

    // ========== Preamp / HPF (Low Cut) ==========
    // X-Air: /ch/{nn}/preamp/hpon (0/1), /ch/{nn}/preamp/hpf (frequency)
    // Behringer wiki: hpf 0.0-1.0 maps to 20-200 Hz (documented). Hardware supports 20-400 Hz, logarithmic scale.
    // Values outside 20-400 are clamped (e.g. 10→20, 500→400).

    async setHPFOn(channel: number, on: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/preamp/hpon`;
        this.sendCommand(path, [on ? 1 : 0]);
    }

    async getHPFOn(channel: number): Promise<boolean> {
        const path = `${this.getChannelPath(channel)}/preamp/hpon`;
        const value = await this.sendAndReceive(path);
        return value === 1;
    }

    async getHPF(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/preamp/hpf`;
        return await this.sendAndReceive(path);
    }

    async getHPFHz(channel: number): Promise<number> {
        const norm = await this.getHPF(channel);
        const logRange = Math.log10(400) - Math.log10(20);
        return 20 * Math.pow(10, norm * logRange);
    }

    async setHPF(channel: number, frequencyHz: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/preamp/hpf`;
        // X-Air: 20-400 Hz, float 0.0-1.0 (logarithmic scale). Mixer quantizes to steps (coarser at high Hz).
        // Nudge +1 Hz below 250 only; no nudge at 250+ (user prefers e.g. 300→296 over 300→305).
        const hz = Math.max(20, Math.min(400, frequencyHz));
        const nudge = hz < 250 ? Math.min(400, hz + 1) : hz;
        const normalized =
            (Math.log10(nudge) - Math.log10(20)) /
            (Math.log10(400) - Math.log10(20));
        this.sendCommand(path, [normalized]);
    }

    // ========== EQ Controls ==========

    async setEQ(channel: number, band: number, gain: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/g`;
        const mixerGain = (gain + 15) / 30;
        this.sendCommand(path, [mixerGain]);
    }

    async getEQ(channel: number, band: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/g`;
        const value = await this.sendAndReceive(path);
        return value * 30 - 15;
    }

    async setEQFrequency(channel: number, band: number, frequency: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/f`;
        const value =
            (Math.log10(Math.max(20, Math.min(20000, frequency))) - Math.log10(20)) /
            (Math.log10(20000) - Math.log10(20));
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
        const mixerThreshold = (threshold + 80) / 80;
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
        const mixerThreshold = (threshold + 60) / 60;
        const mixerRatio = (ratio - 1) / 19;
        this.sendCommand(thrPath, [mixerThreshold]);
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

    // ========== Sends ==========

    async sendToBus(channel: number, bus: number, level: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/${bus.toString().padStart(2, "0")}/level`;
        this.sendCommand(path, [level]);
    }

    /**
     * Send channel to FX effect (FX 1-4 = buses 7-10).
     * Level uses X-Air scale: 0.0 = -∞dB, 0.75 = 0dB, 1.0 = +10dB.
     * For dB conversion: value = 0.75 * 10^(dB/40)
     */
    async sendToFx(channel: number, effect: number, level: number): Promise<void> {
        if (effect < 1 || effect > 4) return;
        const bus = 6 + effect; // FX 1→7, FX 2→8, FX 3→9, FX 4→10
        return this.sendToBus(channel, bus, level);
    }

    async getSendToFx(channel: number, effect: number): Promise<number> {
        if (effect < 1 || effect > 4) return 0;
        const bus = 6 + effect;
        return this.getSendToBus(channel, bus);
    }

    /**
     * Convert dB to X-Air FX send level (calibrated from X-Air Edit display).
     * Display formula: dB ≈ 66*log10(value)+8. Inverse: value = 10^((dB-8)/66)
     */
    static dbToLevel(db: number): number {
        if (db <= -100) return 0;
        return Math.max(0, Math.min(1, Math.pow(10, (db - 8) / 66)));
    }

    async getSendToBus(channel: number, bus: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/mix/${bus.toString().padStart(2, "0")}/level`;
        return await this.sendAndReceive(path);
    }

    async setSendPrePost(channel: number, bus: number, pre: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/${bus.toString().padStart(2, "0")}/preamp`;
        this.sendCommand(path, [pre ? 1 : 0]);
    }

    // ========== Main Mix ==========

    async setMainFader(level: number): Promise<void> {
        this.sendCommand("/lr/mix/fader", [level]);
    }

    async getMainFader(): Promise<number> {
        return await this.sendAndReceive("/lr/mix/fader");
    }

    async muteMain(mute: boolean): Promise<void> {
        this.sendCommand("/lr/mix/on", [mute ? 0 : 1]);
    }

    async setMainPan(pan: number): Promise<void> {
        const mixerPan = (pan + 1) / 2;
        this.sendCommand("/lr/mix/pan", [mixerPan]);
    }

    // ========== Effects (X-Air: 1-4) ==========

    async setEffectOn(effect: number, on: boolean): Promise<void> {
        if (effect < 1 || effect > 4) return;
        this.sendCommand(`/fx/${effect}/insert`, [on ? 1 : 0]);
    }

    async setEffectMix(effect: number, mix: number): Promise<void> {
        if (effect < 1 || effect > 4) return;
        this.sendCommand(`/fx/${effect}/mix`, [mix]);
    }

    async setEffectParam(effect: number, param: number, value: number): Promise<void> {
        if (effect < 1 || effect > 4) return;
        this.sendCommand(`/fx/${effect}/par/${param.toString().padStart(2, "0")}`, [value]);
    }

    // ========== Routing ==========

    async setChannelSource(channel: number, source: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/config/insrc`;
        const value = Math.max(0, Math.min(15, source));
        this.sendCommand(path, [value]);
    }

    async getChannelSource(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/config/insrc`;
        return await this.sendAndReceive(path);
    }

    // ========== Scenes (X-Air: 1-64) ==========

    async recallScene(scene: number): Promise<void> {
        scene = Math.max(1, Math.min(64, Math.round(scene)));
        this.sendCommand("/-snap/load", [scene]);
    }

    async saveScene(scene: number, name?: string): Promise<void> {
        scene = Math.max(1, Math.min(64, Math.round(scene)));
        this.sendCommand("/-snap/load", [scene]);
        if (name) this.sendCommand("/-snap/name", [name]);
        this.sendCommand("/-snap/save", [scene]);
    }

    async getSceneName(scene: number): Promise<string> {
        scene = Math.max(1, Math.min(64, Math.round(scene)));
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

    // ========== Meters ==========

    async getChannelMeter(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/mix/fader`;
        return await this.sendAndReceive(path);
    }

    // ========== Status ==========

    async getMixerStatus(): Promise<any> {
        try {
            const info = await this.sendAndReceive("/xinfo");
            return {
                connected: true,
                host: this.host,
                port: this.port,
                mixerFamily: "x-air",
                effectsRange: "1-4",
                scenesRange: "1-64",
                info,
            };
        } catch (error) {
            return {
                connected: false,
                host: this.host,
                port: this.port,
                mixerFamily: "x-air",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    // ========== Custom Commands ==========

    async sendCustomCommand(address: string, value?: any): Promise<void> {
        if (value === undefined) {
            this.sendCommand(address);
        } else {
            this.sendCommand(address, Array.isArray(value) ? value : [value]);
        }
    }

    close(): void {
        this.isConnected = false;
        this.osc.close();
    }
}
