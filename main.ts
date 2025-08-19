import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	MarkdownView
} from 'obsidian';

interface AutoScrollSettings {
	/** pixels / 10ms (compat com configs antigas) */
	speed: number;
	showRibbonIcon: boolean;
}

// ===== Faixa/escala novas (lento → até 0.30) =====
const MIN_SPEED = 0.01;     // 1 px/s
const MAX_SPEED = 0.30;     // 30 px/s
const SPEED_STEP = 0.01;    // passo fino para slider/atalhos

// ===== Default calculado para leitura “normal” =====
// Aproximação: 220 wpm, ~12 palavras/linha, line-height ~24 px
// → ~0.31 linha/s → ~7.3 px/s → 0.073 px/10ms  ≈ 0.07
const DEFAULT_SETTINGS: AutoScrollSettings = {
	speed: 0.07,
	showRibbonIcon: true,
};

const ribbonActiveClassName = 'autoscroll-extended-ribbon-active';
const pluginId = 'obsidian-autoscroll-extended';

// atraso para considerar "parou de rolar" e retomar o autoscroll
const WHEEL_RESUME_DELAY_MS = 300;

export default class AutoScrollPlugin extends Plugin {
	settings: AutoScrollSettings;

	active = false;
	private rafId: number | null = null;
	private lastTs: number | null = null;
	private pixelAccumulator = 0;
	private lastTop: number | null = null;

	// pausa temporária causada por wheel (retoma sozinho)
	private pausedByWheel = false;
	private wheelResumeTimer: number | null = null;

	ribbonIconEl: HTMLElement | null = null;

	// listeners (precisam ser campos para remover depois)
	private boundOnUserWheel = (_e: WheelEvent) => this.onUserWheel();
	private boundOnUserKey = (_e: KeyboardEvent) => this.onUserScrollInteraction();
	private boundOnUserMouse = (_e: MouseEvent) => this.onUserScrollInteraction();

	// ====== Ciclo de vida ======
	async onload() {
		await this.loadSettings();

		// Comandos + hotkeys (o usuário pode mudar em Settings → Hotkeys)
		this.addCommand({
			id: 'toggle-scrolling',
			name: 'AutoScroll Extended: toggle scrolling',
			hotkeys: [{ modifiers: ['Mod', 'Alt'], key: 's' }],
			callback: () => this.toggleScrolling(),
		});

		this.addCommand({
			id: 'increase-speed',
			name: 'AutoScroll Extended: increase speed',
			hotkeys: [{ modifiers: ['Mod', 'Alt'], key: '=' }], // +/=
			callback: async () => this.bumpSpeed(+SPEED_STEP),
		});

		this.addCommand({
			id: 'decrease-speed',
			name: 'AutoScroll Extended: decrease speed',
			hotkeys: [{ modifiers: ['Mod', 'Alt'], key: '-' }],
			callback: async () => this.bumpSpeed(-SPEED_STEP),
		});

		if (this.settings.showRibbonIcon) {
			this.createOrRefreshRibbon();
		}

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.resubscribeUserInteractionListeners();
				this.lastTop = null; // força re-sync no próximo frame
			})
		);

		this.addSettingTab(new AutoScrollSettingTab(this.app, this));
		this.resubscribeUserInteractionListeners();
	}

	onunload() {
		this.stopScroll();
		this.removeRibbon();
		this.unsubscribeUserInteractionListeners();
	}

	// ====== API invocada por comandos / ribbon ======

	public toggleScrolling() {
		if (this.active) this.stopScroll();
		else this.startScroll();
	}

	public async bumpSpeed(step: number) {
		const next = Math.round((this.settings.speed + step) * 100) / 100;
		// wrap MIN..MAX
		this.settings.speed = next > MAX_SPEED ? MIN_SPEED : next < MIN_SPEED ? MAX_SPEED : next;
		await this.saveSettingsAndRefreshUI();
		new Notice('Setting speed to ' + this.settings.speed.toFixed(2));
	}

	// ====== Loop de autoscroll ======
	private startScroll() {
		if (this.active) return;

		this.active = true;
		this.lastTs = null;
		this.pixelAccumulator = 0;
		this.lastTop = null;
		this.pausedByWheel = false;
		if (this.wheelResumeTimer) {
			window.clearTimeout(this.wheelResumeTimer);
			this.wheelResumeTimer = null;
		}

		this.ribbonIconEl?.addClass(ribbonActiveClassName);
		new Notice('Starting Auto Scroller');

		this.resubscribeUserInteractionListeners();

		const tick = (ts: number) => {
			if (!this.active) return;

			// se está pausado por wheel, apenas aguarde retomar
			if (this.pausedByWheel) {
				this.lastTs = null; // rebaseia o delta quando retomar
				this.rafId = requestAnimationFrame(tick);
				return;
			}

			if (this.lastTs == null) this.lastTs = ts;
			const dtMs = ts - this.lastTs;
			this.lastTs = ts;

			const pxPerMs = this.settings.speed / 10; // speed é px/10ms
			this.pixelAccumulator += pxPerMs * dtMs;

			if (this.pixelAccumulator >= 1) {
				const target = this.getActiveScrollTarget();
				if (!target) {
					new Notice('Editor view lost');
					this.stopScroll();
					return;
				}

				const currentTop = target.getTop();

				// Se o usuário mexeu (teclas/mouse down), re-sincronize (sem voltar)
				if (this.lastTop !== null && Math.abs(currentTop - this.lastTop) > 2) {
					this.pixelAccumulator = 0;
				}

				const delta = Math.floor(this.pixelAccumulator);
				const desiredTop = currentTop + delta;

				target.setTop(desiredTop);
				this.pixelAccumulator -= delta;

				const newTop = target.getTop();
				if (newTop === currentTop) {
					new Notice('Scrolled to the end!');
					this.stopScroll();
					return;
				}

				this.lastTop = newTop;
			}

			this.rafId = requestAnimationFrame(tick);
		};

		this.rafId = requestAnimationFrame(tick);
	}

	private stopScroll() {
		if (!this.active) return;

		this.ribbonIconEl?.removeClass(ribbonActiveClassName);
		new Notice('Stopping Auto Scroller');

		if (this.rafId != null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		if (this.wheelResumeTimer) {
			window.clearTimeout(this.wheelResumeTimer);
			this.wheelResumeTimer = null;
		}
		this.active = false;
		this.pausedByWheel = false;
		this.lastTs = null;
		this.pixelAccumulator = 0;
	}

	// ====== Abstração do alvo (Editor / Reading) ======
	private getActiveScrollTarget():
		| {
			type: 'editor' | 'reading';
			getTop: () => number;
			setTop: (top: number) => void;
		}
		| null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return null;

		if (view.getMode() === 'source') {
			const editor = view.editor;
			if (!editor) return null;
			return {
				type: 'editor',
				getTop: () => editor.getScrollInfo().top,
				setTop: (top: number) => {
					const { left } = editor.getScrollInfo();
					editor.scrollTo(left, top);
				},
			};
		}

		const el = view.containerEl.querySelector<HTMLElement>('.markdown-reading-view');
		if (el) {
			return {
				type: 'reading',
				getTop: () => el.scrollTop,
				setTop: (top: number) => el.scrollTo({ top }),
			};
		}
		// fallback: container do view
		return {
			type: 'reading',
			getTop: () => view.containerEl.scrollTop,
			setTop: (top: number) => view.containerEl.scrollTo({ top }),
		};
	}

	// ====== Interação do usuário ======

	// Qualquer tecla / mousedown apenas muda a linha de base (não pausa)
	private onUserScrollInteraction() {
		if (!this.active) return;
		this.lastTop = null;
	}

	// Wheel: pausa imediatamente e agenda a retomada automática
	private onUserWheel() {
		if (!this.active) return;

		// pausa só por wheel
		this.pausedByWheel = true;
		this.pixelAccumulator = 0;
		this.lastTop = null;
		this.lastTs = null;

		if (this.wheelResumeTimer) {
			window.clearTimeout(this.wheelResumeTimer);
		}
		this.wheelResumeTimer = window.setTimeout(() => {
			// retoma do ponto atual
			this.pausedByWheel = false;
			this.lastTop = null;
			this.lastTs = null; // rebaseia o tempo para evitar “pulo”
		}, WHEEL_RESUME_DELAY_MS);
	}

	private resubscribeUserInteractionListeners() {
		this.unsubscribeUserInteractionListeners();
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const container = view?.containerEl ?? this.app.workspace.containerEl;
		container.addEventListener('wheel', this.boundOnUserWheel, { passive: true });
		container.addEventListener('keydown', this.boundOnUserKey, true); // capture
		container.addEventListener('mousedown', this.boundOnUserMouse, { passive: true });
	}

	private unsubscribeUserInteractionListeners() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const container = view?.containerEl ?? this.app.workspace.containerEl;
		container.removeEventListener('wheel', this.boundOnUserWheel as EventListener);
		container.removeEventListener('keydown', this.boundOnUserKey as EventListener, true);
		container.removeEventListener('mousedown', this.boundOnUserMouse as EventListener);
	}

	// ====== Ribbon & UI ======
	public createOrRefreshRibbon() {
		this.removeRibbon();
		this.ribbonIconEl = this.addRibbonIcon(
			'double-down-arrow-glyph',
			this.ribbonTooltip(),
			(e) => {
				if (e.button === 0) {
					this.toggleScrolling();
				} else {
					void this.bumpSpeed(+SPEED_STEP);
				}
			}
		);
		if (this.active) this.ribbonIconEl.addClass(ribbonActiveClassName);
	}

	public removeRibbon() {
		this.ribbonIconEl?.remove();
		this.ribbonIconEl = null;
	}

	private ribbonTooltip() {
		return `AutoScroll Extended (speed ${this.settings.speed.toFixed(2)} px/10ms)`;
	}

	public async saveSettingsAndRefreshUI() {
		// clamp novo
		this.settings.speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, Number(this.settings.speed) || DEFAULT_SETTINGS.speed));
		await this.saveSettings();

		if (this.ribbonIconEl) {
			const tip = this.ribbonTooltip();
			this.ribbonIconEl.setAttr('aria-label', tip);
			this.ribbonIconEl.setAttr('data-tooltip', tip);
		}
	}

	// ====== Settings persistence ======
	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
		if (typeof this.settings.speed !== 'number' || isNaN(this.settings.speed))
			this.settings.speed = DEFAULT_SETTINGS.speed;
		this.settings.speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, this.settings.speed));
		if (typeof this.settings.showRibbonIcon !== 'boolean')
			this.settings.showRibbonIcon = DEFAULT_SETTINGS.showRibbonIcon;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class AutoScrollSettingTab extends PluginSettingTab {
	plugin: AutoScrollPlugin;

	constructor(app: App, plugin: AutoScrollPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Settings • AutoScroll Extended' });

		new Setting(containerEl)
			.setName('Show Ribbon Icon')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showRibbonIcon)
					.onChange(async (value) => {
						this.plugin.settings.showRibbonIcon = value;
						await this.plugin.saveSettings();
						if (value) this.plugin.createOrRefreshRibbon();
						else this.plugin.removeRibbon();
					})
			);

		new Setting(containerEl)
			.setName('Default scrolling speed')
			.setDesc('Pixels per 10 ms (slow → 0.30)')
			.addSlider((slider) =>
				slider
					.setLimits(MIN_SPEED, MAX_SPEED, SPEED_STEP)
					.setValue(this.plugin.settings.speed)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.speed = value;
						await this.plugin.saveSettingsAndRefreshUI();
					})
			);
	}
}
