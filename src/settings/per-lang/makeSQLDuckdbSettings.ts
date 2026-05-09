import {Setting} from "obsidian";
import {SettingsTab} from "../SettingsTab";

export default (tab: SettingsTab, containerEl: HTMLElement) => {
	containerEl.createEl('h3', {text: 'SQL-DuckDB Settings'});
	new Setting(containerEl)
		.setName('DuckDB path')
		.setDesc("Path to your DuckDB CLI. Default: duckdb")
		.addText(text => text
			.setValue(tab.plugin.settings.sqlDuckdbPath)
			.onChange(async (value) => {
				const sanitized = tab.sanitizePath(value);
				tab.plugin.settings.sqlDuckdbPath = sanitized;
				await tab.plugin.saveSettings();
			}));
	new Setting(containerEl)
		.setName('DuckDB arguments')
		.setDesc('Arguments for the DuckDB CLI. Default: -csv')
		.addText(text => text
			.setValue(tab.plugin.settings.sqlDuckdbArgs)
			.onChange(async (value) => {
				tab.plugin.settings.sqlDuckdbArgs = value;
				await tab.plugin.saveSettings();
			}));
	tab.makeInjectSetting(containerEl, "sql-duckdb");
}
