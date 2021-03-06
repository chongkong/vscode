/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {TPromise} from 'vs/base/common/winjs.base';
import mime = require('vs/base/common/mime');
import strinput = require('vs/workbench/common/editor/stringEditorInput');
import {EditorInput, EditorModel} from 'vs/workbench/common/editor';
import uri from 'vs/base/common/uri';
import {IInstantiationService} from 'vs/platform/instantiation/common/instantiation';

export class DebugStringEditorInput extends strinput.StringEditorInput {

	constructor(
		name: string,
		private resourceUrl: uri,
		description: string,
		value: string,
		mimeType: string,
		singleton: boolean,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super(name, description, value, mimeType || mime.MIME_TEXT, singleton, instantiationService);
	}

	public getResource(): uri {
		return this.resourceUrl;
	}
}

export class DebugErrorEditorInput extends EditorInput {

	public static ID = 'workbench.editors.debugErrorEditorInput';

	constructor(private name: string, public value: string) {
		super();
	}

	public getTypeId(): string {
		return DebugErrorEditorInput.ID;
	}

	public resolve(refresh?: boolean): TPromise<EditorModel> {
		return TPromise.as(null);
	}

	public getName(): string {
		return this.name;
	}
}
