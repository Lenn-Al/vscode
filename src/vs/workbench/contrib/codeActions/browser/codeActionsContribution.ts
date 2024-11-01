/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../base/common/jsonSchema.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { editorConfigurationBaseNode } from '../../../../editor/common/config/editorConfigurationSchema.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { codeActionCommandId, refactorCommandId, sourceActionCommandId } from '../../../../editor/contrib/codeAction/browser/codeAction.js';
import { CodeActionKind } from '../../../../editor/contrib/codeAction/common/types.js';
import * as nls from '../../../../nls.js';
import { ConfigurationScope, Extensions, IConfigurationNode, IConfigurationPropertySchema, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { CodeActionsExtensionPoint, ContributedCodeAction } from '../common/codeActionsExtensionPoint.js';
import { IExtensionPoint } from '../../../services/extensions/common/extensionsRegistry.js';

const createCodeActionsAutoSave = (description: string): IJSONSchema => {
	return {
		type: 'string',
		enum: ['always', 'explicit', 'never', true, false],
		enumDescriptions: [
			nls.localize('alwaysSave', 'Triggers Code Actions on explicit saves and auto saves triggered by window or focus changes.'),
			nls.localize('explicitSave', 'Triggers Code Actions only when explicitly saved'),
			nls.localize('neverSave', 'Never triggers Code Actions on save'),
			nls.localize('explicitSaveBoolean', 'Triggers Code Actions only when explicitly saved. This value will be deprecated in favor of "explicit".'),
			nls.localize('neverSaveBoolean', 'Never triggers Code Actions on save. This value will be deprecated in favor of "never".')
		],
		default: 'explicit',
		description: description
	};
};

const createNotebookCodeActionsAutoSave = (description: string): IJSONSchema => {
	return {
		type: ['string', 'boolean'],
		enum: ['explicit', 'never', true, false],
		enumDescriptions: [
			nls.localize('explicit', 'Triggers Code Actions only when explicitly saved.'),
			nls.localize('never', 'Never triggers Code Actions on save.'),
			nls.localize('explicitBoolean', 'Triggers Code Actions only when explicitly saved. This value will be deprecated in favor of "explicit".'),
			nls.localize('neverBoolean', 'Triggers Code Actions only when explicitly saved. This value will be deprecated in favor of "never".')
		],
		default: 'explicit',
		description: description
	};
};


const codeActionsOnSaveSchema: IConfigurationPropertySchema = {
	oneOf: [
		{
			type: 'object',
			additionalProperties: {
				type: 'string'
			},
		},
		{
			type: 'array',
			items: { type: 'string' }
		}
	],
	markdownDescription: nls.localize('editor.codeActionsOnSave', 'Run Code Actions for the editor on save. Code Actions must be specified and the editor must not be shutting down. When {0} is set to `afterDelay`, Code Actions will only be run when the file is saved explicitly. Example: `"source.organizeImports": "explicit" `', '`#files.autoSave#`'),
	type: ['object', 'array'],
	additionalProperties: {
		type: 'string',
		enum: ['always', 'explicit', 'never', true, false],
	},
	default: {},
	scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
};

export const editorConfiguration = Object.freeze<IConfigurationNode>({
	...editorConfigurationBaseNode,
	properties: {
		'editor.codeActionsOnSave': codeActionsOnSaveSchema
	}
});

const notebookCodeActionsOnSaveSchema: IConfigurationPropertySchema = {
	oneOf: [
		{
			type: 'object',
			additionalProperties: {
				type: 'string'
			},
		},
		{
			type: 'array',
			items: { type: 'string' }
		}
	],
	markdownDescription: nls.localize('notebook.codeActionsOnSave', 'Run a series of Code Actions for a notebook on save. Code Actions must be specified and the editor must not be shutting down. When {0} is set to `afterDelay`, Code Actions will only be run when the file is saved explicitly. Example: `"notebook.source.organizeImports": "explicit"`', '`#files.autoSave#`'),
	type: 'object',
	additionalProperties: {
		type: ['string', 'boolean'],
		enum: ['explicit', 'never', true, false],
		// enum: ['explicit', 'always', 'never'], -- autosave support needs to be built first
		// nls.localize('always', 'Always triggers Code Actions on save, including autosave, focus, and window change events.'),
	},
	default: {}
};

export const notebookEditorConfiguration = Object.freeze<IConfigurationNode>({
	...editorConfigurationBaseNode,
	properties: {
		'notebook.codeActionsOnSave': notebookCodeActionsOnSaveSchema
	}
});

export class CodeActionsContribution extends Disposable implements IWorkbenchContribution {

	private _contributedCodeActions: CodeActionsExtensionPoint[] = [];
	private settings: Set<string> = new Set<string>();

	private readonly _onDidChangeContributions = this._register(new Emitter<void>());

	constructor(
		codeActionsExtensionPoint: IExtensionPoint<CodeActionsExtensionPoint[]>,
		@IKeybindingService keybindingService: IKeybindingService,
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService
	) {
		super();

		// TODO: @justschen caching of code actions based on extensions loaded: https://github.com/microsoft/vscode/issues/216019
		languageFeatures.codeActionProvider.onDidChange(() => {
			this.updateSettingsFromCodeActionProviders();
			this.updateConfigurationSchemaFromContribs();
		}, 2000);

		codeActionsExtensionPoint.setHandler(extensionPoints => {
			this._contributedCodeActions = extensionPoints.flatMap(x => x.value).filter(x => Array.isArray(x.actions));
			this.updateConfigurationSchema(this._contributedCodeActions);
			this._onDidChangeContributions.fire();
		});

		keybindingService.registerSchemaContribution({
			getSchemaAdditions: () => this.getSchemaAdditions(),
			onDidChange: this._onDidChangeContributions.event,
		});
	}

	private updateSettingsFromCodeActionProviders(): void {
		const providers = this.languageFeatures.codeActionProvider.allNoModel();
		providers.forEach(provider => {
			if (provider.providedCodeActionKinds) {
				provider.providedCodeActionKinds.forEach(kind => {
					if (!this.settings.has(kind) && CodeActionKind.Source.contains(new HierarchicalKind(kind))) {
						this.settings.add(kind);
					}
				});
			}
		});
	}

	private updateConfigurationSchema(codeActionContributions: readonly CodeActionsExtensionPoint[]) {
		const newProperties: IJSONSchemaMap = {};
		const newNotebookProperties: IJSONSchemaMap = {};
		for (const [sourceAction, props] of this.getSourceActions(codeActionContributions)) {
			this.settings.add(sourceAction);
			newProperties[sourceAction] = createCodeActionsAutoSave(nls.localize('codeActionsOnSave.generic', "Controls whether '{0}' actions should be run on file save.", props.title));
			newNotebookProperties[sourceAction] = createNotebookCodeActionsAutoSave(nls.localize('codeActionsOnSave.generic', "Controls whether '{0}' actions should be run on file save.", props.title));
		}
		codeActionsOnSaveSchema.properties = newProperties;
		notebookCodeActionsOnSaveSchema.properties = newNotebookProperties;
		Registry.as<IConfigurationRegistry>(Extensions.Configuration)
			.notifyConfigurationSchemaUpdated(editorConfiguration);
	}

	private updateConfigurationSchemaFromContribs() {
		const properties: IJSONSchemaMap = { ...codeActionsOnSaveSchema.properties };
		const notebookProperties: IJSONSchemaMap = { ...notebookCodeActionsOnSaveSchema.properties };
		for (const codeActionKind of this.settings) {
			if (!properties[codeActionKind]) {
				properties[codeActionKind] = createCodeActionsAutoSave(nls.localize('codeActionsOnSave.generic', "Controls whether '{0}' actions should be run on file save.", codeActionKind));
				notebookProperties[codeActionKind] = createNotebookCodeActionsAutoSave(nls.localize('codeActionsOnSave.generic', "Controls whether '{0}' actions should be run on file save.", codeActionKind));
			}
		}
		codeActionsOnSaveSchema.properties = properties;
		notebookCodeActionsOnSaveSchema.properties = notebookProperties;
		Registry.as<IConfigurationRegistry>(Extensions.Configuration)
			.notifyConfigurationSchemaUpdated(editorConfiguration);
	}

	private getSourceActions(contributions: readonly CodeActionsExtensionPoint[]) {
		const sourceActions = new Map<string, { readonly title: string }>();
		for (const contribution of contributions) {
			for (const action of contribution.actions) {
				const kind = new HierarchicalKind(action.kind);
				if (CodeActionKind.Source.contains(kind)) {
					sourceActions.set(kind.value, action);
				}
			}
		}
		return sourceActions;
	}

	private getSchemaAdditions(): IJSONSchema[] {
		const conditionalSchema = (command: string, actions: readonly ContributedCodeAction[]): IJSONSchema => {
			return {
				if: {
					required: ['command'],
					properties: {
						'command': { const: command }
					}
				},
				then: {
					properties: {
						'args': {
							required: ['kind'],
							properties: {
								'kind': {
									anyOf: [
										{
											enum: actions.map(action => action.kind),
											enumDescriptions: actions.map(action => action.description ?? action.title),
										},
										{ type: 'string' },
									]
								}
							}
						}
					}
				}
			};
		};

		const getActions = (ofKind: HierarchicalKind): ContributedCodeAction[] => {
			const allActions = this._contributedCodeActions.flatMap(desc => desc.actions);

			const out = new Map<string, ContributedCodeAction>();
			for (const action of allActions) {
				if (!out.has(action.kind) && ofKind.contains(new HierarchicalKind(action.kind))) {
					out.set(action.kind, action);
				}
			}
			return Array.from(out.values());
		};

		return [
			conditionalSchema(codeActionCommandId, getActions(HierarchicalKind.Empty)),
			conditionalSchema(refactorCommandId, getActions(CodeActionKind.Refactor)),
			conditionalSchema(sourceActionCommandId, getActions(CodeActionKind.Source)),
		];
	}
}
