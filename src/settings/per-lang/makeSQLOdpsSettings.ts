import {Setting} from "obsidian";
import {SettingsTab} from "../SettingsTab";

export default (tab: SettingsTab, containerEl: HTMLElement) => {
	containerEl.createEl('h3', {text: 'SQL-ODPS Settings'});
	new Setting(containerEl)
		.setName('ODPS path')
		.setDesc("Path to your ODPS CLI. Default: odpscmd")
		.addText(text => text
			.setValue(tab.plugin.settings.sqlOdpsPath)
			.onChange(async (value) => {
				const sanitized = tab.sanitizePath(value);
				tab.plugin.settings.sqlOdpsPath = sanitized;
				await tab.plugin.saveSettings();
			}));
	new Setting(containerEl)
		.setName('ODPS arguments')
		.setDesc('Arguments for the ODPS CLI. Default: -f')
		.addText(text => text
			.setValue(tab.plugin.settings.sqlOdpsArgs)
			.onChange(async (value) => {
				tab.plugin.settings.sqlOdpsArgs = value;
				await tab.plugin.saveSettings();
			}));
	tab.makeInjectSetting(containerEl, "sql-odps");
}
