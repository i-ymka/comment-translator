import * as vscode from 'vscode';
import { SettingsPanelProvider } from './webview/settingsPanelProvider';
import { TranslationService } from './translationService';
import { FileParser } from './fileParser';

// Virtual document provider for translation preview
class TranslationPreviewProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;
    private documents = new Map<string, string>();

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.documents.get(uri.toString()) || '';
    }

    update(uri: vscode.Uri, content: string) {
        this.documents.set(uri.toString(), content);
        this._onDidChange.fire(uri);
    }

    clear(uri: vscode.Uri) {
        this.documents.delete(uri.toString());
    }
}

// Status bar buttons
let translateStatusBarItem: vscode.StatusBarItem;  // Always visible
let applyStatusBarItem: vscode.StatusBarItem;       // Only during preview
let revertStatusBarItem: vscode.StatusBarItem;      // Only during preview

function showTranslationStatusBar() {
    applyStatusBarItem.show();
    revertStatusBarItem.show();
    translateStatusBarItem.hide();  // Hide translate button during preview
}

function hideTranslationStatusBar() {
    applyStatusBarItem.hide();
    revertStatusBarItem.hide();
    translateStatusBarItem.show();  // Show translate button again
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Comment Translator extension is now active');

    // Register virtual document provider
    const previewProvider = new TranslationPreviewProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('comment-translator-preview', previewProvider)
    );

    // Create ALWAYS VISIBLE translate button in status bar
    translateStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    translateStatusBarItem.text = "$(globe) Translate";
    translateStatusBarItem.tooltip = "Click to translate current file, Right-click for settings";
    translateStatusBarItem.command = 'commentTranslator.translateCurrentFile';
    translateStatusBarItem.show();  // Always visible!
    context.subscriptions.push(translateStatusBarItem);

    // Create Apply/Cancel buttons (only visible during preview)
    applyStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    applyStatusBarItem.text = "$(check) Apply Translation";
    applyStatusBarItem.tooltip = "Apply the translation to the file";
    applyStatusBarItem.command = 'commentTranslator.applyTranslation';
    applyStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    context.subscriptions.push(applyStatusBarItem);

    revertStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    revertStatusBarItem.text = "$(close) Cancel";
    revertStatusBarItem.tooltip = "Cancel and close the preview";
    revertStatusBarItem.command = 'commentTranslator.revertTranslation';
    context.subscriptions.push(revertStatusBarItem);

    // Initialize services
    const translationService = new TranslationService();
    const fileParser = new FileParser();
    let settingsPanel: SettingsPanelProvider | undefined;

    // Register open settings command
    const openSettingsCommand = vscode.commands.registerCommand(
        'commentTranslator.openSettings',
        () => {
            if (settingsPanel) {
                settingsPanel.reveal();
            } else {
                settingsPanel = new SettingsPanelProvider(
                    context.extensionUri,
                    translationService,
                    fileParser,
                    previewProvider,
                    showTranslationStatusBar
                );
                settingsPanel.onDispose(() => {
                    settingsPanel = undefined;
                });
            }
        }
    );

    // Register translate current file command (for editor title button)
    const translateCurrentFileCommand = vscode.commands.registerCommand(
        'commentTranslator.translateCurrentFile',
        async () => {
            // Create panel if not exists (but don't show it)
            if (!settingsPanel) {
                settingsPanel = new SettingsPanelProvider(
                    context.extensionUri,
                    translationService,
                    fileParser,
                    previewProvider,
                    showTranslationStatusBar
                );
                settingsPanel.onDispose(() => {
                    settingsPanel = undefined;
                });
            }
            // Translate current file only
            await settingsPanel.executeTranslation('currentFile');
        }
    );

    // Register translate project command
    const translateCommand = vscode.commands.registerCommand(
        'commentTranslator.translate',
        async () => {
            if (!settingsPanel) {
                vscode.window.showInformationMessage(
                    'Opening Comment Translator settings first...'
                );
                vscode.commands.executeCommand('commentTranslator.openSettings');
            } else {
                await settingsPanel.executeTranslation('wholeProject');
            }
        }
    );

    // Register apply translation command (for status bar button)
    const applyTranslationCommand = vscode.commands.registerCommand(
        'commentTranslator.applyTranslation',
        async () => {
            if (settingsPanel) {
                await settingsPanel.applyCurrentTranslation();
                hideTranslationStatusBar();
            }
        }
    );

    // Register revert translation command (for status bar button)
    const revertTranslationCommand = vscode.commands.registerCommand(
        'commentTranslator.revertTranslation',
        async () => {
            if (settingsPanel) {
                await settingsPanel.revertCurrentTranslation();
                hideTranslationStatusBar();
            }
        }
    );

    context.subscriptions.push(
        translateCommand,
        translateCurrentFileCommand,
        openSettingsCommand,
        applyTranslationCommand,
        revertTranslationCommand
    );
}

export function deactivate() {
    console.log('Comment Translator extension is now deactivated');
}
