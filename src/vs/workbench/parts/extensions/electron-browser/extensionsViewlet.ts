/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./media/extensionsViewlet';
import { localize } from 'vs/nls';
import { ThrottledDelayer, always } from 'vs/base/common/async';
import { TPromise } from 'vs/base/common/winjs.base';
import { isPromiseCanceledError, onUnexpectedError, create as createError } from 'vs/base/common/errors';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { Builder, Dimension } from 'vs/base/browser/builder';
import { assign } from 'vs/base/common/objects';
import EventOf, { mapEvent, chain } from 'vs/base/common/event';
import { IAction } from 'vs/base/common/actions';
import { domEvent } from 'vs/base/browser/event';
import { Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { KeyCode } from 'vs/base/common/keyCodes';
import { Viewlet } from 'vs/workbench/browser/viewlet';
import { IViewlet } from 'vs/workbench/common/viewlet';
import { IViewletService } from 'vs/workbench/services/viewlet/common/viewletService';
import { append, $, addStandardDisposableListener, EventType, addClass, removeClass, toggleClass } from 'vs/base/browser/dom';
import { PagedModel } from 'vs/base/common/paging';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { PagedList } from 'vs/base/browser/ui/list/listPaging';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Delegate, Renderer } from './extensionsList';
import { IExtensionsWorkbenchService, IExtension, IExtensionsViewlet, VIEWLET_ID, ExtensionState } from './extensions';
import { ShowRecommendedExtensionsAction, ShowWorkspaceRecommendedExtensionsAction, ShowPopularExtensionsAction, ShowInstalledExtensionsAction, ShowOutdatedExtensionsAction, ClearExtensionsInputAction, ChangeSortAction, UpdateAllAction, InstallVSIXAction } from './extensionsActions';
import { IExtensionManagementService, IExtensionGalleryService, IExtensionTipsService, SortBy, SortOrder, IQueryOptions } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionsInput } from './extensionsInput';
import { Query } from '../common/extensionQuery';
import { OpenGlobalSettingsAction } from 'vs/workbench/browser/actions/openSettings';
import { IProgressService } from 'vs/platform/progress/common/progress';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { IMessageService, CloseAction } from 'vs/platform/message/common/message';
import Severity from 'vs/base/common/severity';
import { IActivityService, ProgressBadge, NumberBadge } from 'vs/workbench/services/activity/common/activityService';

interface SearchInputEvent extends Event {
	target: HTMLInputElement;
	immediate?: boolean;
}

export class ExtensionsViewlet extends Viewlet implements IExtensionsViewlet {

	private onSearchChange: EventOf<string>;
	private searchDelayer: ThrottledDelayer<any>;
	private root: HTMLElement;
	private searchBox: HTMLInputElement;
	private extensionsBox: HTMLElement;
	private list: PagedList<IExtension>;
	private primaryActions: IAction[];
	private secondaryActions: IAction[];
	private disposables: IDisposable[] = [];

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IExtensionGalleryService private galleryService: IExtensionGalleryService,
		@IExtensionManagementService private extensionService: IExtensionManagementService,
		@IProgressService private progressService: IProgressService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IEditorGroupService private editorInputService: IEditorGroupService,
		@IExtensionsWorkbenchService private extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IExtensionTipsService private tipsService: IExtensionTipsService,
		@IMessageService private messageService: IMessageService,
		@IViewletService private viewletService: IViewletService
	) {
		super(VIEWLET_ID, telemetryService);
		this.searchDelayer = new ThrottledDelayer(500);

		this.disposables.push(viewletService.onDidViewletOpen(this.onViewletOpen, this, this.disposables));
	}

	create(parent: Builder): TPromise<void> {
		super.create(parent);
		parent.addClass('extensions-viewlet');
		this.root = parent.getHTMLElement();

		const header = append(this.root, $('.header'));

		this.searchBox = append(header, $<HTMLInputElement>('input.search-box'));
		this.searchBox.placeholder = localize('searchExtensions', "Search Extensions in Marketplace");
		this.disposables.push(addStandardDisposableListener(this.searchBox, EventType.FOCUS, () => addClass(this.searchBox, 'synthetic-focus')));
		this.disposables.push(addStandardDisposableListener(this.searchBox, EventType.BLUR, () => removeClass(this.searchBox, 'synthetic-focus')));
		this.extensionsBox = append(this.root, $('.extensions'));

		const delegate = new Delegate();
		const renderer = this.instantiationService.createInstance(Renderer);
		this.list = new PagedList(this.extensionsBox, delegate, [renderer]);

		const onKeyDown = chain(domEvent(this.searchBox, 'keydown'))
			.map(e => new StandardKeyboardEvent(e));

		onKeyDown.filter(e => e.keyCode === KeyCode.Enter).on(this.onEnter, this, this.disposables);
		onKeyDown.filter(e => e.keyCode === KeyCode.Escape).on(this.onEscape, this, this.disposables);
		onKeyDown.filter(e => e.keyCode === KeyCode.UpArrow).on(this.onUpArrow, this, this.disposables);
		onKeyDown.filter(e => e.keyCode === KeyCode.DownArrow).on(this.onDownArrow, this, this.disposables);
		onKeyDown.filter(e => e.keyCode === KeyCode.PageUp).on(this.onPageUpArrow, this, this.disposables);
		onKeyDown.filter(e => e.keyCode === KeyCode.PageDown).on(this.onPageDownArrow, this, this.disposables);

		const onSearchInput = domEvent(this.searchBox, 'input') as EventOf<SearchInputEvent>;
		onSearchInput(e => this.triggerSearch(e.target.value, e.immediate), null, this.disposables);

		this.onSearchChange = mapEvent(onSearchInput, e => e.target.value);

		chain(this.list.onSelectionChange)
			.map(e => e.elements[0])
			.filter(e => !!e)
			.on(this.openExtension, this, this.disposables);

		return TPromise.as(null);
	}

	setVisible(visible:boolean): TPromise<void> {
		return super.setVisible(visible).then(() => {
			if (visible) {
				this.searchBox.focus();
				this.searchBox.setSelectionRange(0, this.searchBox.value.length);
				this.triggerSearch(this.searchBox.value, true, true);
			} else {
				this.list.model = new PagedModel([]);
			}
		});
	}

	focus(): void {
		this.searchBox.focus();
	}

	layout({ height, width }: Dimension):void {
		this.list.layout(height - 38);
		toggleClass(this.root, 'narrow', width <= 300);
	}

	getOptimalWidth(): number {
		return 400;
	}

	getActions(): IAction[] {
		if (!this.primaryActions) {
			this.primaryActions = [
				this.instantiationService.createInstance(ClearExtensionsInputAction, ClearExtensionsInputAction.ID, ClearExtensionsInputAction.LABEL, this.onSearchChange)
			];
		}

		return this.primaryActions;
	}

	getSecondaryActions(): IAction[] {
		if (!this.secondaryActions) {
			this.secondaryActions = [
				this.instantiationService.createInstance(UpdateAllAction, UpdateAllAction.ID, UpdateAllAction.LABEL),
				new Separator(),
				this.instantiationService.createInstance(ShowInstalledExtensionsAction, ShowInstalledExtensionsAction.ID, ShowInstalledExtensionsAction.LABEL),
				this.instantiationService.createInstance(ShowOutdatedExtensionsAction, ShowOutdatedExtensionsAction.ID, ShowOutdatedExtensionsAction.LABEL),
				this.instantiationService.createInstance(ShowRecommendedExtensionsAction, ShowRecommendedExtensionsAction.ID, ShowRecommendedExtensionsAction.LABEL),
				this.instantiationService.createInstance(ShowWorkspaceRecommendedExtensionsAction, ShowWorkspaceRecommendedExtensionsAction.ID, ShowWorkspaceRecommendedExtensionsAction.LABEL),
				this.instantiationService.createInstance(ShowPopularExtensionsAction, ShowPopularExtensionsAction.ID, ShowPopularExtensionsAction.LABEL),
				new Separator(),
				this.instantiationService.createInstance(ChangeSortAction, 'extensions.sort.install', localize('sort by installs', "Sort By: Install Count"), this.onSearchChange, 'installs', undefined),
				this.instantiationService.createInstance(ChangeSortAction, 'extensions.sort.rating', localize('sort by rating', "Sort By: Rating"), this.onSearchChange, 'rating', undefined),
				new Separator(),
				this.instantiationService.createInstance(ChangeSortAction, 'extensions.sort..asc', localize('ascending', "Sort Order: ↑"), this.onSearchChange, undefined, 'asc'),
				this.instantiationService.createInstance(ChangeSortAction, 'extensions.sort..desc', localize('descending', "Sort Order: ↓"), this.onSearchChange, undefined, 'desc'),
				new Separator(),
				this.instantiationService.createInstance(InstallVSIXAction, InstallVSIXAction.ID, InstallVSIXAction.LABEL)
			];
		}

		return this.secondaryActions;
	}

	search(value: string): void {
		const event = new Event('input', { bubbles: true }) as SearchInputEvent;
		event.immediate = true;

		this.searchBox.value = value;
		this.searchBox.dispatchEvent(event);
	}

	private triggerSearch(value: string, immediate = false, suggestPopular = false): void {
		this.searchDelayer.trigger(() => this.doSearch(value, suggestPopular), immediate || !value ? 0 : 500)
			.done(null, err => this.onError(err));
	}

	private doSearch(value: string = '', suggestPopular = false): TPromise<any> {
		return this.progress(this.query(value))
			.then(model => {
				if (!value && model.length === 0 && suggestPopular) {
					return this.search('@sort:installs');
				}

				this.list.model = model;
				this.list.scrollTop = 0;
			});
	}

	private query(value: string): TPromise<PagedModel<IExtension>> {
		if (!value || /@outdated/i.test(value)) {
			let local = this.extensionsWorkbenchService.queryLocal();

			if (/@outdated/i.test(value)) {
				local = local.then(result => result.filter(e => e.outdated));
			}

			return local.then(result => new PagedModel(result));
		}

		const query = Query.parse(value);
		let options: IQueryOptions = {};

		switch(query.sortBy) {
			case 'installs': options = assign(options, { sortBy: SortBy.InstallCount }); break;
			case 'rating': options = assign(options, { sortBy: SortBy.AverageRating }); break;
		}

		switch (query.sortOrder) {
			case 'asc': options = assign(options, { sortOrder: SortOrder.Ascending }); break;
			case 'desc': options = assign(options, { sortOrder: SortOrder.Descending }); break;
		}

		if (/@recommended:workspace/i.test(query.value)) {
			return this.queryWorkspaceRecommendedExtensions();
		}

		if (/@recommended/i.test(query.value)) {
			const value = query.value.replace(/@recommended/g, '').trim().toLowerCase();

			return this.extensionsWorkbenchService.queryLocal().then(local => {
				const names = this.tipsService.getRecommendations()
					.filter(name => local.every(ext => `${ ext.publisher }.${ ext.name }` !== name))
					.filter(name => name.toLowerCase().indexOf(value) > -1);

				this.telemetryService.publicLog('extensionRecommendations:open', { count: names.length });

				if (!names.length) {
					return new PagedModel([]);
				}

				return this.extensionsWorkbenchService.queryGallery(assign(options, { names, pageSize: names.length }))
					.then(result => new PagedModel(result));
			});
		}

		if (query.value) {
			options = assign(options, { text: query.value.substr(0, 200) });
		}

		return this.extensionsWorkbenchService.queryGallery(options)
			.then(result => new PagedModel(result));
	}

	private queryWorkspaceRecommendedExtensions(): TPromise<PagedModel<IExtension>> {
		let names = this.tipsService.getWorkspaceRecommendations();

		this.telemetryService.publicLog('extensionWorkspaceRecommendations:open', { count: names.length });

		if (!names.length) {
			return TPromise.as(new PagedModel([]));
		}
		return this.extensionsWorkbenchService.queryGallery({ names, pageSize: names.length })
				.then(result => new PagedModel(result));
	}

	private openExtension(extension: IExtension): void {
		this.editorService.openEditor(this.instantiationService.createInstance(ExtensionsInput, extension))
			.done(null, err => this.onError(err));
	}

	private onEnter(): void {
		this.list.setSelection(...this.list.getFocus());
	}

	private onEscape(): void {
		this.search('');
	}

	private onUpArrow(): void {
		this.list.focusPrevious();
		this.list.reveal(this.list.getFocus()[0]);
	}

	private onDownArrow(): void {
		this.list.focusNext();
		this.list.reveal(this.list.getFocus()[0]);
	}

	private onPageUpArrow(): void {
		this.list.focusPreviousPage();
		this.list.reveal(this.list.getFocus()[0]);
	}

	private onPageDownArrow(): void {
		this.list.focusNextPage();
		this.list.reveal(this.list.getFocus()[0]);
	}

	private progress<T>(promise: TPromise<T>): TPromise<T> {
		const progressRunner = this.progressService.show(true);
		return always(promise, () => progressRunner.done());
	}

	private onViewletOpen(viewlet: IViewlet): void {
		if (!viewlet || viewlet.getId() === VIEWLET_ID) {
			return;
		}

		const model = this.editorInputService.getStacksModel();

		const promises = model.groups.map(group => {
			const position = model.positionOfGroup(group);
			const inputs = group.getEditors().filter(input => input instanceof ExtensionsInput);
			const promises = inputs.map(input => this.editorService.closeEditor(position, input));

			return TPromise.join(promises);
		});

		TPromise.join(promises).done(null, onUnexpectedError);
	}

	private onError(err: any): void {
		if (isPromiseCanceledError(err)) {
			return;
		}

		const message = err && err.message || '';

		if (/ECONNREFUSED/.test(message)) {
			const error = createError(localize('suggestProxyError', "Marketplace returned 'ECONNREFUSED'. Please check the 'http.proxy' setting."), {
				actions: [
					this.instantiationService.createInstance(OpenGlobalSettingsAction, OpenGlobalSettingsAction.ID, OpenGlobalSettingsAction.LABEL),
					CloseAction
				]
			});

			this.messageService.show(Severity.Error, error);
			return;
		}

		this.messageService.show(Severity.Error, err);
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
		super.dispose();
	}
}

export class StatusUpdater implements IWorkbenchContribution {

	private disposables: IDisposable[];

	constructor(
		@IActivityService private activityService: IActivityService,
		@IExtensionsWorkbenchService private extensionsWorkbenchService: IExtensionsWorkbenchService
	) {
		extensionsWorkbenchService.onChange(this.onServiceChange, this, this.disposables);
	}

	getId(): string {
		return 'vs.extensions.statusupdater';
	}

	private onServiceChange(): void {
		if (this.extensionsWorkbenchService.local.some(e => e.state === ExtensionState.Installing)) {
			this.activityService.showActivity(VIEWLET_ID, new ProgressBadge(() => localize('extensions', 'Extensions')), 'extensions-badge progress-badge');
			return;
		}

		const outdated = this.extensionsWorkbenchService.local.reduce((r, e) => r + (e.outdated ? 1 : 0), 0);

		if (outdated > 0) {
			const badge = new NumberBadge(outdated, n => localize('outdatedExtensions', '{0} Outdated Extensions', n));
			this.activityService.showActivity(VIEWLET_ID, badge, 'extensions-badge count-badge');
		} else {
			this.activityService.showActivity(VIEWLET_ID, null, 'extensions-badge');
		}
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
	}
}
