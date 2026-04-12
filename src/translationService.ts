import * as vscode from 'vscode';
import * as deepl from 'deepl-node';

export interface TranslationResult {
    original: string;
    translated: string;
    detectedSourceLang?: string;
}

export class TranslationService {
    private translator: deepl.Translator | null = null;
    private cache: Map<string, string> = new Map();

    constructor() {
        this.initializeTranslator();
    }

    private initializeTranslator() {
        const config = vscode.workspace.getConfiguration('commentTranslator');
        const apiKey = config.get<string>('deeplApiKey');

        console.log(`[Translation Service] Initializing with API key: ${apiKey ? apiKey.substring(0, 10) + '...' : 'NOT SET'}`);

        if (apiKey && apiKey.trim() !== '') {
            try {
                // DeepL Free API keys end with ':fx' and use different endpoint
                // The library handles this automatically, just pass the key
                this.translator = new deepl.Translator(apiKey);
                console.log('[Translation Service] Translator initialized successfully');
                console.log(`[Translation Service] Using ${apiKey.endsWith(':fx') ? 'FREE' : 'PRO'} API endpoint`);
            } catch (error) {
                console.error('[Translation Service] Failed to initialize:', error);
                vscode.window.showErrorMessage(
                    `Failed to initialize DeepL translator: ${error}`
                );
            }
        } else {
            console.warn('[Translation Service] API key is empty or not configured');
        }
    }

    public reinitialize() {
        this.translator = null;
        this.initializeTranslator();
    }

    public async translate(
        text: string,
        targetLang?: string
    ): Promise<TranslationResult | null> {
        if (!this.translator) {
            this.initializeTranslator();
            if (!this.translator) {
                vscode.window.showErrorMessage(
                    'DeepL API key is not configured. Please set it in settings.'
                );
                return null;
            }
        }

        const config = vscode.workspace.getConfiguration('commentTranslator');
        const target = targetLang || config.get<string>('targetLanguage', 'EN-US');

        // Check cache
        const cacheKey = `${text}|${target}`;
        if (this.cache.has(cacheKey)) {
            return {
                original: text,
                translated: this.cache.get(cacheKey)!,
            };
        }

        try {
            const result = await this.translator.translateText(
                text,
                null,
                target as deepl.TargetLanguageCode
            );

            const translated = typeof result === 'string' ? result : result.text;

            // Cache result
            this.cache.set(cacheKey, translated);

            return {
                original: text,
                translated,
                detectedSourceLang: typeof result === 'object' ? result.detectedSourceLang : undefined,
            };
        } catch (error) {
            vscode.window.showErrorMessage(`Translation failed: ${error}`);
            return null;
        }
    }

    public async translateBatch(
        texts: string[],
        targetLang?: string
    ): Promise<TranslationResult[]> {
        if (!this.translator) {
            this.initializeTranslator();
            if (!this.translator) {
                vscode.window.showErrorMessage(
                    'DeepL API key is not configured. Please set it in settings.'
                );
                return [];
            }
        }

        const config = vscode.workspace.getConfiguration('commentTranslator');
        const target = targetLang || config.get<string>('targetLanguage', 'EN-US');

        // Filter out already cached texts
        const textsToTranslate: string[] = [];
        const results: TranslationResult[] = [];

        for (const text of texts) {
            const cacheKey = `${text}|${target}`;
            if (this.cache.has(cacheKey)) {
                results.push({
                    original: text,
                    translated: this.cache.get(cacheKey)!,
                });
            } else {
                textsToTranslate.push(text);
            }
        }

        if (textsToTranslate.length === 0) {
            return results;
        }

        try {
            const translations = await this.translator.translateText(
                textsToTranslate,
                null,
                target as deepl.TargetLanguageCode
            );

            const translationArray = Array.isArray(translations)
                ? translations
                : [translations];

            for (let i = 0; i < textsToTranslate.length; i++) {
                const text = textsToTranslate[i];
                const translation = translationArray[i];
                const translated = typeof translation === 'string'
                    ? translation
                    : translation.text;

                // Cache result
                const cacheKey = `${text}|${target}`;
                this.cache.set(cacheKey, translated);

                results.push({
                    original: text,
                    translated,
                    detectedSourceLang: typeof translation === 'object'
                        ? translation.detectedSourceLang
                        : undefined,
                });
            }

            return results;
        } catch (error: any) {
            console.error('[Translation Service] Batch translation failed:', error);

            // Check if it's an authorization error
            if (error.message && (error.message.includes('Authorization') || error.message.includes('not allowed to access the API'))) {
                const errorMsg = `DeepL API authorization failed!\n\n` +
                    `Possible reasons:\n` +
                    `1. Invalid API key - make sure you copied it correctly\n` +
                    `2. You're using a DeepL website account key (not API key)\n` +
                    `3. Your API key is for DeepL Pro (not Free)\n\n` +
                    `How to get a FREE API key:\n` +
                    `1. Go to https://www.deepl.com/pro-api\n` +
                    `2. Sign up for "DeepL API Free"\n` +
                    `3. Copy your API Authentication Key\n` +
                    `4. Paste it in the settings and click "Save Settings"\n\n` +
                    `Technical error: ${error.message}`;

                vscode.window.showErrorMessage(errorMsg, 'Open DeepL API Page').then(selection => {
                    if (selection === 'Open DeepL API Page') {
                        vscode.env.openExternal(vscode.Uri.parse('https://www.deepl.com/pro-api'));
                    }
                });
            } else {
                vscode.window.showErrorMessage(`Batch translation failed: ${error}`);
            }

            // Return empty array on error to prevent showing "Translation complete"
            return [];
        }
    }

    public clearCache() {
        this.cache.clear();
    }

    public isConfigured(): boolean {
        const config = vscode.workspace.getConfiguration('commentTranslator');
        const apiKey = config.get<string>('deeplApiKey');
        return apiKey !== undefined && apiKey.trim() !== '';
    }

    public async checkUsage(): Promise<deepl.Usage | null> {
        if (!this.translator) {
            return null;
        }

        try {
            return await this.translator.getUsage();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get usage info: ${error}`);
            return null;
        }
    }
}
