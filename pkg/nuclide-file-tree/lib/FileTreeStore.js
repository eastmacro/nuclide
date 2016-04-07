'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {HgRepositoryClient} from '../../nuclide-hg-repository-client';
import type {
  RemoteDirectory,
  RemoteFile,
} from '../../nuclide-remote-connection';

import FileTreeDispatcher from './FileTreeDispatcher';
import FileTreeHelpers from './FileTreeHelpers';
import {FileTreeNode} from './FileTreeNode';
import Immutable from 'immutable';
import {ActionType} from './FileTreeConstants';
import {Emitter} from 'atom';
import {Minimatch} from 'minimatch';
import {repositoryForPath} from '../../nuclide-hg-git-bridge';
import {StatusCodeNumber} from '../../nuclide-hg-repository-base/lib/hg-constants';
import invariant from 'assert';
import {getLogger} from '../../nuclide-logging';
import shell from 'shell';

import {WorkingSet} from '../../nuclide-working-sets';

// Used to ensure the version we serialized is the same version we are deserializing.
const VERSION = 1;

import type {Directory} from './FileTreeHelpers';
import type {Dispatcher} from 'flux';
import type {NuclideUri} from '../../nuclide-remote-uri';
import type {WorkingSetsStore} from '../../nuclide-working-sets/lib/WorkingSetsStore';
import type {StatusCodeNumberValue} from '../../nuclide-hg-repository-base/lib/HgService';


type ActionPayload = Object;
type ChangeListener = () => mixed;

export type ExportStoreData = {
  childKeyMap: { [key: string]: Array<string> };
  expandedKeysByRoot: { [key: string]: Array<string> };
  rootKeys: Array<string>;
  selectedKeysByRoot: { [key: string]: Array<string> };
  version: number;
};

export type StoreConfigData = {
    vcsStatuses: {[rootUri: NuclideUri]: {[path: NuclideUri]: StatusCodeNumberValue}};
    workingSet: WorkingSet;
    hideIgnoredNames: boolean;
    excludeVcsIgnoredPaths: boolean;
    ignoredPatterns: Immutable.Set<Minimatch>;
    usePreviewTabs: boolean;
    isEditingWorkingSet: boolean;
    openFilesWorkingSet: WorkingSet;
    reposByRoot: {[rootUri: NuclideUri]: atom$Repository};
};

export type NodeCheckedStatus = 'checked' | 'clear' | 'partial';


const DEFAULT_CONF = {
  vcsStatuses: {},
  workingSet: new WorkingSet(),
  editedWorkingSet: new WorkingSet(),
  hideIgnoredNames: true,
  excludeVcsIgnoredPaths: true,
  ignoredPatterns: new Immutable.Set(),
  usePreviewTabs: false,
  isEditingWorkingSet: false,
  openFilesWorkingSet: new WorkingSet(),
  reposByRoot: {},
};

let instance: ?Object;

/**
 * Implements the Flux pattern for our file tree. All state for the file tree will be kept in
 * FileTreeStore and the only way to update the store is through methods on FileTreeActions. The
 * dispatcher is a mechanism through which FileTreeActions interfaces with FileTreeStore.
 */
export class FileTreeStore {
  roots: Immutable.OrderedMap<NuclideUri, FileTreeNode>;
  _conf: StoreConfigData; // The configuration for the file-tree. Avoid direct writing.
  _workingSetsStore: ?WorkingSetsStore;
  _usePrefixNav: boolean;
  _isLoadingMap: Immutable.Map<NuclideUri, Promise<void>>;
  _repositories: Immutable.Set<atom$Repository>;

  _dispatcher: Dispatcher;
  _emitter: Emitter;
  _logger: any;
  _animationFrameRequestId: ?number;
  _suppressChanges: boolean;
  _cwdKey: ?NuclideUri;

  usePrevNav: boolean;

  static getInstance(): FileTreeStore {
    if (!instance) {
      instance = new FileTreeStore();
    }
    return instance;
  }

  static dispose(): void {
    if (instance != null) {
      instance.dispose();
    }

    instance = null;
  }

  constructor() {
    this.roots = new Immutable.OrderedMap();
    this._dispatcher = FileTreeDispatcher.getInstance();
    this._emitter = new Emitter();
    this._dispatcher.register(
      payload => this._onDispatch(payload)
    );
    this._logger = getLogger();

    this._usePrefixNav = false;
    this._isLoadingMap = new Immutable.Map();
    this._repositories = new Immutable.Set();

    this._conf = DEFAULT_CONF;
    global.FTConf = this._conf;
    this._suppressChanges = false;
  }

  /**
   * TODO: Move to a [serialization class][1] and use the built-in versioning mechanism. This might
   * need to be done one level higher within main.js.
   *
   * [1]: https://atom.io/docs/latest/behind-atom-serialization-in-atom
   */
  exportData(): ExportStoreData {
    const childKeyMap = {};
    const expandedKeysByRoot = {};
    const selectedKeysByRoot = {};

    this.roots.forEach(root => {
      const expandedKeys = [];
      const selectedKeys = [];

      // Grab the data of only the expanded portion of the tree.
      root.traverse(
        node => {
          if (node.isSelected) {
            selectedKeys.push(node.uri);
          }

          if (!node.isExpanded) {
            return false;
          }

          expandedKeys.push(node.uri);

          if (!node.children.isEmpty()) {
            childKeyMap[node.uri] = node.children.map(child => child.uri).toArray();
          }

          return true;
        }
      );

      expandedKeysByRoot[root.uri] = expandedKeys;
      selectedKeysByRoot[root.uri] = selectedKeys;
    });

    const rootKeys = this.roots.map(root => root.uri).toArray();

    return {
      version: VERSION,
      childKeyMap: childKeyMap,
      expandedKeysByRoot,
      rootKeys,
      selectedKeysByRoot,
    };
  }

  /**
   * Imports store data from a previous export.
   */
  loadData(data: ExportStoreData): void {
    // Ensure we are not trying to load data from an earlier version of this package.
    if (data.version !== VERSION) {
      return;
    }

    const buildNode = (rootUri: string, uri: string) => {
      const rootExpandedKeys = data.expandedKeysByRoot[rootUri] || [];
      const rootSelectedKeys = data.selectedKeysByRoot[rootUri] || [];
      const childrenUris = data.childKeyMap[uri] || [];
      const children = FileTreeNode.childrenFromArray(
        childrenUris.map(childUri => buildNode(rootUri, childUri))
      );

      const isExpanded = rootExpandedKeys.indexOf(uri) >= 0;
      let isLoading = false;

      if (isExpanded && FileTreeHelpers.isDirKey(uri)) {
        this._fetchChildKeys(uri);
        isLoading = true;
      }

      return new FileTreeNode({
        uri,
        rootUri,
        isExpanded,
        isSelected: rootSelectedKeys.indexOf(uri) >= 0,
        isLoading,
        isTracked: false,
        children,
        isCwd: false,
        connectionTitle: FileTreeHelpers.getDisplayTitle(rootUri) || '',
      },
      this._conf);
    };

    this._setRoots(new Immutable.OrderedMap(
      data.rootKeys.map(rootUri => [rootUri, buildNode(rootUri, rootUri)])
    ));
  }

  _setExcludeVcsIgnoredPaths(excludeVcsIgnoredPaths: boolean): void {
    this._updateConf(conf => conf.excludeVcsIgnoredPaths = excludeVcsIgnoredPaths);
  }

  _setHideIgnoredNames(hideIgnoredNames: boolean): void {
    this._updateConf(conf => conf.hideIgnoredNames = hideIgnoredNames);
  }

  /**
   * Given a list of names to ignore, compile them into minimatch patterns and
   * update the store with them.
   */
  _setIgnoredNames(ignoredNames: Array<string>) {
    const ignoredPatterns = Immutable.Set(ignoredNames)
      .map(ignoredName => {
        if (ignoredName === '') {
          return null;
        }
        try {
          return new Minimatch(ignoredName, {matchBase: true, dot: true});
        } catch (error) {
          atom.notifications.addWarning(
            `Error parsing pattern '${ignoredName}' from "Settings" > "Ignored Names"`,
            {detail: error.message},
          );
          return null;
        }
      })
      .filter(pattern => pattern != null);
    this._updateConf(conf => conf.ignoredPatterns = ignoredPatterns);
  }

  _onDispatch(payload: ActionPayload): void {
    switch (payload.actionType) {
      case ActionType.DELETE_SELECTED_NODES:
        this._deleteSelectedNodes().catch(error => {
          atom.notifications.addError('Deleting nodes failed with an error: ' + error.toString());
        });
        break;
      case ActionType.SET_CWD:
        this._setCwdKey(payload.rootKey);
        break;
      case ActionType.SET_TRACKED_NODE:
        this._setTrackedNode(payload.rootKey, payload.nodeKey);
        break;
      case ActionType.SET_ROOT_KEYS:
        this._setRootKeys(payload.rootKeys);
        break;
      case ActionType.EXPAND_NODE:
        this._expandNode(payload.rootKey, payload.nodeKey);
        break;
      case ActionType.EXPAND_NODE_DEEP:
        this._expandNodeDeep(payload.rootKey, payload.nodeKey);
        break;
      case ActionType.COLLAPSE_NODE:
        this._collapseNode(payload.rootKey, payload.nodeKey);
        break;
      case ActionType.SET_EXCLUDE_VCS_IGNORED_PATHS:
        this._setExcludeVcsIgnoredPaths(payload.excludeVcsIgnoredPaths);
        break;
      case ActionType.SET_USE_PREVIEW_TABS:
        this._setUsePreviewTabs(payload.usePreviewTabs);
        break;
      case ActionType.SET_USE_PREFIX_NAV:
        this._setUsePrefixNav(payload.usePrefixNav);
        break;
      case ActionType.COLLAPSE_NODE_DEEP:
        this._collapseNodeDeep(payload.rootKey, payload.nodeKey);
        break;
      case ActionType.SET_HIDE_IGNORED_NAMES:
        this._setHideIgnoredNames(payload.hideIgnoredNames);
        break;
      case ActionType.SET_IGNORED_NAMES:
        this._setIgnoredNames(payload.ignoredNames);
        break;
      case ActionType.SET_VCS_STATUSES:
        this._setVcsStatuses(payload.rootKey, payload.vcsStatuses);
        break;
      case ActionType.SET_REPOSITORIES:
        this._setRepositories(payload.repositories);
        break;
      case ActionType.SET_WORKING_SET:
        this._setWorkingSet(payload.workingSet);
        break;
      case ActionType.SET_OPEN_FILES_WORKING_SET:
        this._setOpenFilesWorkingSet(payload.openFilesWorkingSet);
        break;
      case ActionType.SET_WORKING_SETS_STORE:
        this._setWorkingSetsStore(payload.workingSetsStore);
        break;
      case ActionType.START_EDITING_WORKING_SET:
        this._startEditingWorkingSet(payload.editedWorkingSet);
        break;
      case ActionType.FINISH_EDITING_WORKING_SET:
        this._finishEditingWorkingSet();
        break;
      case ActionType.CHECK_NODE:
        this._checkNode(payload.rootKey, payload.nodeKey);
        break;
      case ActionType.UNCHECK_NODE:
        this._uncheckNode(payload.rootKey, payload.nodeKey);
        break;

      case ActionType.SET_SELECTED_NODE:
        this._setSelectedNode(payload.rootKey, payload.nodeKey);
        break;
      case ActionType.ADD_SELECTED_NODE:
        this._addSelectedNode(payload.rootKey, payload.nodeKey);
        break;
      case ActionType.UNSELECT_NODE:
        this._unselectNode(payload.rootKey, payload.nodeKey);
        break;
      case ActionType.MOVE_SELECTION_UP:
        this._moveSelectionUp();
        break;
      case ActionType.MOVE_SELECTION_DOWN:
        this._moveSelectionDown();
        break;
      case ActionType.MOVE_SELECTION_TO_TOP:
        this._moveSelectionToTop();
        break;
      case ActionType.MOVE_SELECTION_TO_BOTTOM:
        this._moveSelectionToBottom();
        break;
      case ActionType.ENSURE_CHILD_NODE:
        this._ensureChildNode(payload.nodeKey);
        break;
    }
  }

  /**
  * Use the predicate function to update one or more of the roots in the file tree
  */
  _updateRoots(predicate: (root: FileTreeNode) => FileTreeNode): void {
    this._setRoots(this.roots.map(predicate));
  }

  /**
  * Use the predicate to update a node (or a branch) of the file-tree
  */
  _updateNodeAtRoot(
    rootKey: NuclideUri,
    nodeKey: NuclideUri,
    predicate: (node: FileTreeNode) => FileTreeNode,
  ): void {
    const root = this.roots.get(rootKey);
    if (root == null) {
      return;
    }

    const node = root.find(nodeKey);
    if (node == null) {
      return;
    }

    const roots = this.roots.set(rootKey, this._bubbleUp(node, predicate(node)));
    this._setRoots(roots);
  }

  /**
  * Update a node or a branch under any of the roots it was found at
  */
  _updateNodeAtAllRoots(
    nodeKey: NuclideUri,
    predicate: (node: FileTreeNode
  ) => FileTreeNode): void {

    const roots = this.roots.map(root => {
      const node = root.find(nodeKey);
      if (node == null) {
        return root;
      }

      return this._bubbleUp(node, predicate(node));
    });

    this._setRoots(roots);
  }

  /**
  * Bubble the change up. The newNode is assumed to be prevNode after some manipulateion done to it
  * therefore they are assumed to belong to the same parent.
  *
  * The method updates the child to the new node (which create a new parent instance) and call
  * recursively for the parent update. Until there are no more parents and the new root is returned
  *
  * As the change bubbles up, and in addition to the change from the new child assignment, an
  * optional predicate is also being applied to each newly created parent to support more complex
  * change patterns.
  */
  _bubbleUp(
    prevNode: FileTreeNode,
    newNode: FileTreeNode,
    postPredicate: (node: FileTreeNode) => FileTreeNode = (node => node),
  ): FileTreeNode {
    const parent = prevNode.parent;
    if (parent == null) {
      return newNode;
    }

    const newParent = postPredicate(parent.updateChild(newNode));
    return this._bubbleUp(parent, newParent, postPredicate);
  }

  /**
  * Updates the roots, maintains their sibling relationships and fires the change event.
  */
  _setRoots(roots: Immutable.OrderedMap<NuclideUri, FileTreeNode>): void {
    const changed = !Immutable.is(roots, this.roots);
    if (changed) {
      this.roots = roots;
      let prevRoot = null;
      roots.forEach(r => {
        r.prevSibling = prevRoot;
        if (prevRoot != null) {
          prevRoot.nextSibling = r;
        }
        prevRoot = r;
      });

      if (prevRoot != null) {
        prevRoot.nextSibling = null;
      }

      this._emitChange();
    }
  }

  _emitChange(): void {
    if (this._suppressChanges) {
      return;
    }

    if (this._animationFrameRequestId != null) {
      window.cancelAnimationFrame(this._animationFrameRequestId);
    }

    this._animationFrameRequestId = window.requestAnimationFrame(() => {
      this._emitter.emit('change');
      this._suppressChanges = true;
      this._checkTrackedNode();
      this._suppressChanges = false;
      this._animationFrameRequestId = null;
    });
  }

  /**
  * Update the configuration for the file-tree. The direct writing to the this._conf should be
  * avoided.
  */
  _updateConf(predicate: (conf: StoreConfigData) => mixed): void {
    predicate(this._conf);
    this._updateRoots(root => root.updateConf());
  }

  _setRootKeys(rootKeys: Array<NuclideUri>): void {
    const rootNodes = rootKeys.map(rootUri => {
      const root = this.roots.get(rootUri);
      if (root != null) {
        return root;
      }

      return new FileTreeNode({
        uri: rootUri,
        rootUri,
        connectionTitle: FileTreeHelpers.getDisplayTitle(rootUri) || '',
      }, this._conf);
    });
    this._setRoots(new Immutable.OrderedMap(rootNodes.map(root => [root.uri, root])));
    this._setCwdKey(this._cwdKey);
  }

  getTrackedNode(): ?FileTreeNode {
    // Locate the root containing the tracked node efficiently by using the child-derived
    // containsTrackedNode property
    const trackedRoot = this.roots.find(root => root.containsTrackedNode);
    if (trackedRoot == null) {
      return null;
    }

    let trackedNode;
    // Likewise, within the root use the property to efficiently find the needed node
    trackedRoot.traverse(
      node => {
        if (node.isTracked) {
          trackedNode = node;
        }

        return trackedNode == null && node.containsTrackedNode;
      }
    );

    return trackedNode;
  }

  getRepositories(): Immutable.Set<atom$Repository> {
    return this._repositories;
  }

  getWorkingSet(): WorkingSet {
    return this._conf.workingSet;
  }

  getWorkingSetsStore(): ?WorkingSetsStore {
    return this._workingSetsStore;
  }

  getRootKeys(): Array<NuclideUri> {
    return this.roots.toArray().map(root => root.uri);
  }

  /**
   * Returns true if the store has no data, i.e. no roots, no children.
   */
  isEmpty(): boolean {
    return this.roots.isEmpty();
  }

  _setVcsStatuses(
    rootKey: NuclideUri,
    vcsStatuses: {[path: NuclideUri]: StatusCodeNumberValue},
  ): void {
    // We can't build on the child-derived properties to maintain vcs statuses in the entire
    // tree, since the reported VCS status may be for a node that is not yet present in the
    // fetched tree, and so it it can't affect its parents statuses. To have the roots colored
    // consistently we manually add all parents of all of the modified nodes up till the root
    const enrichedVcsStatuses = {...vcsStatuses};

    const ensurePresentParents = uri => {
      if (uri === rootKey) {
        return;
      }

      let current = uri;
      while (current !== rootKey) {
        current = FileTreeHelpers.getParentKey(current);

        if (enrichedVcsStatuses[current] != null) {
          return;
        }

        enrichedVcsStatuses[current] = StatusCodeNumber.MODIFIED;
      }
    };

    Object.keys(vcsStatuses).forEach(uri => {
      const status = vcsStatuses[uri];
      if (
        status === StatusCodeNumber.MODIFIED ||
        status === StatusCodeNumber.ADDED ||
        status === StatusCodeNumber.REMOVED) {
        ensurePresentParents(uri);
      }
    });

    if (this._vcsStatusesAreDifferent(rootKey, enrichedVcsStatuses)) {
      this._updateConf(conf => conf.vcsStatuses[rootKey] = enrichedVcsStatuses);
    }
  }

  _vcsStatusesAreDifferent(
    rootKey: NuclideUri,
    newVcsStatuses: {[path: NuclideUri]: StatusCodeNumberValue}
  ): boolean {
    const currentStatuses = this._conf.vcsStatuses[rootKey];
    if (currentStatuses == null || newVcsStatuses == null) {
      if (currentStatuses !== newVcsStatuses) {
        return true;
      }
    }

    const currentKeys = Object.keys(currentStatuses);
    const newKeys = Object.keys(newVcsStatuses);
    if (currentKeys.length !== newKeys.length) {
      return true;
    }

    return newKeys.some(key => currentStatuses[key] !== newVcsStatuses[key]);
  }

  _setUsePreviewTabs(usePreviewTabs: boolean): void {
    this._updateConf(conf => conf.usePreviewTabs = usePreviewTabs);
  }

  _setUsePrefixNav(usePrefixNav: boolean) {
    this._usePrefixNav = usePrefixNav;
  }

  usePrefixNav(): boolean {
    return this._usePrefixNav;
  }

  /**
   * The node child keys may either be available immediately (cached), or
   * require an async fetch. If all of the children are needed it's easier to
   * return as promise, to make the caller oblivious to the way children were
   * fetched.
   */
  async promiseNodeChildKeys(rootKey: string, nodeKey: string): Promise<Array<NuclideUri>> {
    const shownChildrenUris = node => {
      return node.children.toArray().filter(n => n.shouldBeShown).map(n => n.uri);
    };

    const node = this.getNode(rootKey, nodeKey);
    if (node == null) {
      return [];
    }

    if (!node.isLoading) {
      return shownChildrenUris(node);
    }

    await this._fetchChildKeys(nodeKey);
    return this.promiseNodeChildKeys(rootKey, nodeKey);
  }

  /**
  * Uses the .containsSelection child-derived property to efficiently build the list of the
  * currently selected nodes
  */
  getSelectedNodes(): Immutable.List<FileTreeNode> {
    const selectedNodes = [];
    this.roots.forEach(root => {
      root.traverse(
        node => {
          if (node.isSelected) {
            selectedNodes.push(node);
          }
          return node.containsSelection;
        },
      );
    });
    return new Immutable.List(selectedNodes);
  }

  /**
  * Returns a node if it is the only one selected, or null otherwise
  */
  getSingleSelectedNode(): ?FileTreeNode {
    const selectedNodes = this.getSelectedNodes();

    if (selectedNodes.isEmpty() || selectedNodes.size > 1) {
      return null;
    }

    return selectedNodes.first();
  }

  getNode(rootKey: NuclideUri, nodeKey: NuclideUri): ?FileTreeNode {
    const rootNode = this.roots.get(rootKey);

    if (rootNode == null) {
      return null;
    }

    return rootNode.find(nodeKey);
  }

  isEditingWorkingSet(): boolean {
    return this._conf.isEditingWorkingSet;
  }

  /**
  * Builds the edited working set from the partially-child-derived .checkedStatus property
  */
  getEditedWorkingSet(): WorkingSet {
    const uris = [];

    this.roots.forEach(root => root.traverse(
      node => {
        if (node.checkedStatus === 'partial') {
          return true;
        } else if (node.checkedStatus === 'checked') {
          uris.push(node.uri);
        }

        return false;
      }
    ));

    return new WorkingSet(uris);
  }

  isEditedWorkingSetEmpty(): boolean {
    return this.roots.every(root => root.checkedStatus === 'clear');
  }

  /**
   * Initiates the fetching of node's children if it's not already in the process.
   * Clears the node's .isLoading property once the fetch is complete.
   * Once the fetch is completed, clears the node's .isLoading property, builds the map of the
   * node's children out of the fetched children URIs and a change subscription is created
   * for the node to monitor future changes.
   */
  _fetchChildKeys(nodeKey: NuclideUri): Promise<void> {
    const existingPromise = this._getLoading(nodeKey);
    if (existingPromise != null) {
      return existingPromise;
    }

    const promise = FileTreeHelpers.fetchChildren(nodeKey)
      .catch(error => {
        this._logger.error(`Unable to fetch children for "${nodeKey}".`);
        this._logger.error('Original error: ', error);

        // Collapse the node and clear its loading state on error so the
        // user can retry expanding it.
        this._updateNodeAtAllRoots(nodeKey, node =>
          node.set({isExpanded: false, isLoading: false, children: new Immutable.OrderedMap()})
        );

        this._clearLoading(nodeKey);
      })
      .then(childKeys => {
        const childrenKeys = childKeys || [];
        const directory = FileTreeHelpers.getDirectoryByKey(nodeKey);

        // The node with URI === nodeKey might be present at several roots - update them all
        this._updateNodeAtAllRoots(nodeKey, node => {
          // Maintain the order fetched from the FS
          const childrenNodes = childrenKeys.map(uri => {
            const prevNode = node.find(uri);
            // If we already had a child with this URI - keep it
            if (prevNode != null) {
              return prevNode;
            }

            return node.createChild({
              uri,
              isExpanded: false,
              isSelected: false,
              isLoading: false,
              isCwd: false,
              isTracked: false,
              children: new Immutable.OrderedMap(),
            });
          });

          const children = FileTreeNode.childrenFromArray(childrenNodes);
          // In case previous subscription existed - dispose of it
          if (node.subscription != null) {
            node.subscription.dispose();
          }
          // and create a new subscription
          const subscription = this._makeSubscription(nodeKey, directory);

          // If the fetch indicated that some children were removed - dispose of all
          // their subscriptions
          const removedChildren = node.children.filter(n => !children.has(n.name));
          removedChildren.forEach(c => {
            c.traverse(n => {
              if (n.subscription != null) {
                n.subscription.dispose();
              }

              return true;
            });
          });

          return node.set({isLoading: false, children, subscription});
        });

        this._clearLoading(nodeKey);
      });

    this._setLoading(nodeKey, promise);
    return promise;
  }

  _makeSubscription(nodeKey: NuclideUri, directory: ?Directory): ?IDisposable {
    if (directory == null) {
      return null;
    }

    try {
      // This call might fail if we try to watch a non-existing directory, or if permission denied.
      return directory.onDidChange(() => {
        this._fetchChildKeys(nodeKey);
      });
    } catch (ex) {
      /*
       * Log error and mark the directory as dirty so the failed subscription will be attempted
       * again next time the directory is expanded.
       */
      this._logger.error(`Cannot subscribe to directory "${nodeKey}"`, ex);
      return null;
    }
  }

  _getLoading(nodeKey: NuclideUri): ?Promise<void> {
    return this._isLoadingMap.get(nodeKey);
  }

  _setLoading(nodeKey: NuclideUri, value: Promise<void>): void {
    this._isLoadingMap = this._isLoadingMap.set(nodeKey, value);
  }

  hasCwd(): boolean {
    return this._cwdKey != null;
  }

  _setCwdKey(cwdKey: ?NuclideUri): void {
    this._cwdKey = cwdKey;
    this._updateRoots(root => root.setIsCwd(root.uri === cwdKey));
  }

  /**
   * Resets the node to be kept in view if no more data is being awaited. Safe to call many times
   * because it only changes state if a node is being tracked.
   */
  _checkTrackedNode(): void {
    if (
      /*
       * The loading map being empty is a heuristic for when loading has completed. It is inexact
       * because the loading might be unrelated to the tracked node, however it is cheap and false
       * positives will only last until loading is complete or until the user clicks another node in
       * the tree.
       */
      this._isLoadingMap.isEmpty()
    ) {
      // Loading has completed. Allow scrolling to proceed as usual.
      this._clearTrackedNode();
    }
  }

  _clearLoading(nodeKey: NuclideUri): void {
    this._isLoadingMap = this._isLoadingMap.delete(nodeKey);
  }

  async _deleteSelectedNodes(): Promise<void> {
    const selectedNodes = this.getSelectedNodes();
    await Promise.all(selectedNodes.map(async node => {
      const entry = FileTreeHelpers.getEntryByKey(node.uri);

      if (entry == null) {
        return;
      }
      const path = entry.getPath();
      const repository = node.repo;
      if (repository != null && repository.getType() === 'hg') {
        const hgRepository = ((repository: any): HgRepositoryClient);
        try {
          await hgRepository.remove(path);
        } catch (e) {
          const statuses = await hgRepository.getStatuses([path]);
          const pathStatus = statuses.get(path);
          const goodStatuses = [
            StatusCodeNumber.ADDED,
            StatusCodeNumber.CLEAN,
            StatusCodeNumber.MODIFIED,
          ];
          if (goodStatuses.indexOf(pathStatus) !== -1) {
            atom.notifications.addError(
              'Failed to remove ' + path + ' from version control.  The file will ' +
              'still get deleted but you will have to remove it from your VCS yourself.  Error: ' +
              e.toString(),
            );
          }
        }
      }
      if (FileTreeHelpers.isLocalEntry(entry)) {
        // TODO: This special-case can be eliminated once `delete()` is added to `Directory`
        // and `File`.
        shell.moveItemToTrash(FileTreeHelpers.keyToPath(node.uri));
      } else {
        const remoteFile = ((entry: any): (RemoteFile | RemoteDirectory));
        await remoteFile.delete();
      }
    }));
  }

  _expandNode(rootKey: NuclideUri, nodeKey: NuclideUri): void {
    this._updateNodeAtRoot(rootKey, nodeKey, node => {
      return node.setIsExpanded(true).setRecursive(
        n => !n.isContainer || !n.isExpanded ? n : null,
        n => {
          if (n.isContainer && n.isExpanded) {
            this._fetchChildKeys(n.uri);
            return n.setIsLoading(true);
          }

          return n;
        }
      );
    });
  }

  /**
   * Performes a deep BFS scanning expand of contained nodes.
   * returns - a promise fulfilled when the expand operation is finished
   */
  _expandNodeDeep(rootKey: NuclideUri, nodeKey: NuclideUri): Promise<void> {
    // Stop the traversal after 100 nodes were added to the tree
    const itNodes = new FileTreeStoreBfsIterator(this, rootKey, nodeKey, /* limit*/ 100);
    const promise = new Promise(resolve => {
      const expand = () => {
        const traversedNodeKey = itNodes.traversedNode();
        if (traversedNodeKey) {
          this._expandNode(rootKey, traversedNodeKey);

          const nextPromise = itNodes.next();
          if (nextPromise) {
            nextPromise.then(expand);
          }
        } else {
          resolve();
        }
      };

      expand();
    });

    return promise;
  }

  _collapseNode(rootKey: NuclideUri, nodeKey: NuclideUri): void {
    this._updateNodeAtRoot(rootKey, nodeKey, node => {
      // Clear all selected nodes under the node being collapsed and dispose their subscriptions
      return node.setRecursive(
        childNode => {
          if (childNode.isExpanded) {
            return null;
          }
          return childNode;
        },
        childNode => {
          if (childNode.subscription != null) {
            childNode.subscription.dispose();
          }

          if (childNode.uri === node.uri) {
            return childNode.set({isExpanded: false, subscription: null});
          } else {
            return childNode.set({isSelected: false, subscription: null});
          }
        }
      );
    });
  }

  _collapseNodeDeep(rootKey: NuclideUri, nodeKey: NuclideUri): void {
    this._updateNodeAtRoot(rootKey, nodeKey, node => {
      invariant(node.isExpanded);
      return node.setRecursive(
        /* prePredicate */ null,
        childNode => {
          if (childNode.subscription != null) {
            childNode.subscription.dispose();
          }

          if (childNode !== node) {
            return childNode.set({isExpanded: false, isSelected: false, subscription: null});
          } else {
            return childNode.set({isExpanded: false, subscription: null});
          }
        },
      );
    });
  }

  /**
  * Selects a single node and tracks it.
  */
  _setSelectedNode(rootKey: NuclideUri, nodeKey: NuclideUri): void {
    this._clearSelection();
    this._updateNodeAtRoot(rootKey, nodeKey, node => node.setIsSelected(true));
    this._setTrackedNode(rootKey, nodeKey);
  }

  _addSelectedNode(rootKey: NuclideUri, nodeKey: NuclideUri): void {
    this._updateNodeAtRoot(rootKey, nodeKey, node => node.setIsSelected(true));
  }

  _unselectNode(rootKey: NuclideUri, nodeKey: NuclideUri): void {
    this._updateNodeAtRoot(rootKey, nodeKey, node => node.setIsSelected(false));
  }

  /**
  * Moves the selection one node down. In case several nodes were selected, the topmost (first in
  * the natural visual order) is considered to be the reference point for the move.
  */
  _moveSelectionDown(): void {
    if (this.roots.isEmpty()) {
      return;
    }

    const selectedNodes = this.getSelectedNodes();

    let nodeToSelect;
    if (selectedNodes.isEmpty()) {
      nodeToSelect = this.roots.first();
    } else {
      const selectedNode = selectedNodes.first();
      nodeToSelect = selectedNode.findNext();
    }

    if (nodeToSelect != null) {
      this._setSelectedNode(nodeToSelect.rootUri, nodeToSelect.uri);
    }
  }

  /**
  * Moves the selection one node up. In case several nodes were selected, the topmost (first in
  * the natural visual order) is considered to be the reference point for the move.
  */
  _moveSelectionUp(): void {
    if (this.roots.isEmpty()) {
      return;
    }

    const selectedNodes = this.getSelectedNodes();

    let nodeToSelect;
    if (selectedNodes.isEmpty()) {
      nodeToSelect = this.roots.last().findLastRecursiveChild();
    } else {
      const selectedNode = selectedNodes.first();
      nodeToSelect = selectedNode.findPrevious();
    }

    if (nodeToSelect != null) {
      this._setSelectedNode(nodeToSelect.rootUri, nodeToSelect.uri);
    }
  }

  _moveSelectionToTop(): void {
    if (this.roots.isEmpty()) {
      return;
    }

    let nodeToSelect = this.roots.first();
    if (nodeToSelect != null && !nodeToSelect.shouldBeShown) {
      nodeToSelect = nodeToSelect.findNext();
    }

    if (nodeToSelect != null) {
      this._setSelectedNode(nodeToSelect.uri, nodeToSelect.uri);
    }
  }

  _moveSelectionToBottom(): void {
    if (this.roots.isEmpty()) {
      return;
    }

    const lastRoot = this.roots.last();
    const lastChild = lastRoot.findLastRecursiveChild();
    this._setSelectedNode(lastChild.rootUri, lastChild.uri);
  }

  _clearSelection(): void {
    this._updateRoots(root => {
      return root.setRecursive(
        node => node.containsSelection ? null : node,
        node => node.setIsSelected(false),
      );
    });
  }

  _setRootKeys(rootKeys: Array<NuclideUri>): void {
    const rootNodes = rootKeys.map(rootUri => {
      const root = this.roots.get(rootUri);
      if (root != null) {
        return root;
      }

      return new FileTreeNode({
        uri: rootUri,
        rootUri,
        connectionTitle: FileTreeHelpers.getDisplayTitle(rootUri) || '',
      }, this._conf);
    });

    const roots = new Immutable.OrderedMap(rootNodes.map(root => [root.uri, root]));
    const removedRoots = this.roots.filter(root => !roots.has(root.uri));
    removedRoots.forEach(root => root.traverse(
      node => node.isExpanded,
      node => {
        if (node.subscription != null) {
          node.subscription.dispose();
        }
      }
    ));
    this._setRoots(roots);

    // Just in case there's a race between the update of the root keys and the cwdKey and the cwdKey
    // is set too early - set it again. If there was no race - it's a noop.
    this._setCwdKey(this._cwdKey);
  }

  /**
  * Makes sure a certain child node is present in the file tree, creating all its ancestors, if
  * needed and scheduling a chilld key fetch. Used by the reveal active file functionality.
  */
  _ensureChildNode(nodeKey: NuclideUri): void {
    let firstRootUri;

    const expandNode = node => {
      if (node.isExpanded && node.subscription != null) {
        return node;
      }

      if (node.subscription != null) {
        node.subscription.dispose();
      }

      const directory = FileTreeHelpers.getDirectoryByKey(node.uri);
      const subscription = this._makeSubscription(node.uri, directory);
      return node.set({subscription, isExpanded: true});
    };

    this._updateRoots(root => {
      if (!nodeKey.startsWith(root.uri)) {
        return root;
      }

      if (firstRootUri == null) {
        firstRootUri = root.uri;
      }

      const deepest = root.findDeepest(nodeKey);
      if (deepest == null) {
        return root;
      }

      if (deepest.uri === nodeKey) {
        return this._bubbleUp(
          deepest,
          deepest,
          expandNode,
        );
      }

      const parents = [];
      let currentParentUri = FileTreeHelpers.getParentKey(nodeKey);
      while (currentParentUri !== deepest.uri) {
        parents.push(currentParentUri);
        currentParentUri = FileTreeHelpers.getParentKey(currentParentUri);
      }

      let currentChild = deepest.createChild({uri: nodeKey});

      parents.forEach(currentUri => {
        this._fetchChildKeys(currentUri);
        const parent = deepest.createChild({
          uri: currentUri,
          isLoading: true,
          isExpanded: true,
          children: FileTreeNode.childrenFromArray([currentChild]),
        });

        currentChild = parent;
      });

      this._fetchChildKeys(deepest.uri);
      return this._bubbleUp(
        deepest,
        deepest.set({
          isLoading: true,
          isExpanded: true,
          children: deepest.children.set(currentChild.name, currentChild),
        }),
        expandNode,
      );
    });

    if (firstRootUri != null) {
      this._setSelectedNode(firstRootUri, nodeKey);
    }
  }

  _clearTrackedNode(): void {
    this._updateRoots(root => {
      if (!root.containsTrackedNode) {
        return root;
      }

      return root.setRecursive(
        node => node.containsTrackedNode ? null : node,
        node => node.setIsTracked(false),
      );
    });
  }

  _setTrackedNode(rootKey: NuclideUri, nodeKey: NuclideUri): void {
    this._clearTrackedNode();
    this._updateNodeAtRoot(rootKey, nodeKey, node => node.setIsTracked(true));
  }

  _setRepositories(repositories: Immutable.Set<atom$Repository>): void {
    this._repositories = repositories;
    this._updateConf(conf => {
      const reposByRoot = {};
      this.roots.forEach(root => {
        reposByRoot[root.uri] = repositoryForPath(root.uri);
      });
      conf.reposByRoot = reposByRoot;
    });
  }

  _setWorkingSet(workingSet: WorkingSet): void {
    this._updateConf(conf => conf.workingSet = workingSet);
  }

  _setOpenFilesWorkingSet(openFilesWorkingSet: WorkingSet): void {
    this._updateConf(conf => conf.openFilesWorkingSet = openFilesWorkingSet);
  }

  _setWorkingSetsStore(workingSetsStore: ?WorkingSetsStore): void {
    this._workingSetsStore = workingSetsStore;
  }

  _startEditingWorkingSet(): void {
    this._updateRoots(root =>
      root.setRecursive(null, node => node.setCheckedStatus('clear'))
    );
    this._updateConf(conf => conf.isEditingWorkingSet = true);
  }

  _finishEditingWorkingSet(): void {
    this._updateRoots(root =>
      root.setRecursive(null, node => node.setCheckedStatus('clear'))
    );
    this._updateConf(conf => conf.isEditingWorkingSet = false);
  }

  _checkNode(rootKey: NuclideUri, nodeKey: NuclideUri): void {
    if (!this._conf.isEditingWorkingSet) {
      return;
    }

    this._updateNodeAtRoot(rootKey, nodeKey, node => {
      return node.setRecursive(
        n => n.checkedStatus === 'checked' ? n : null,
        n => n.setCheckedStatus('checked'),
      );
    });
  }

  _uncheckNode(rootKey: NuclideUri, nodeKey: NuclideUri): void {
    if (!this._conf.isEditingWorkingSet) {
      return;
    }

    this._updateNodeAtRoot(rootKey, nodeKey, node => {
      return node.setRecursive(
        n => n.checkedStatus === 'clear' ? n : null,
        n => n.setCheckedStatus('clear'),
      );
    });
  }

  reset(): void {
    this.roots.forEach(root => {
      root.traverse(n => {
        if (n.subscription != null) {
          n.subscription.dispose();
        }

        return true;
      });
    });

    // Reset data store.
    this._conf = DEFAULT_CONF;
    this._setRoots(new Immutable.OrderedMap());
  }

  subscribe(listener: ChangeListener): IDisposable {
    return this._emitter.on('change', listener);
  }
}

/**
 * Performs a breadth-first iteration over the directories of the tree starting
 * with a given node. The iteration stops once a given limit of nodes (both directories
 * and files) were traversed.
 * The node being currently traversed can be obtained by calling .traversedNode()
 * .next() returns a promise that is fulfilled when the traversal moves on to
 * the next directory.
 */
class FileTreeStoreBfsIterator {
  _fileTreeStore: FileTreeStore;
  _rootKey: NuclideUri;
  _nodesToTraverse: Array<NuclideUri>;
  _currentlyTraversedNode: ?NuclideUri;
  _limit: number;
  _numNodesTraversed: number;
  _promise: ?Promise<void>;
  _count: number;

  constructor(
      fileTreeStore: FileTreeStore,
      rootKey: NuclideUri,
      nodeKey: NuclideUri,
      limit: number) {
    this._fileTreeStore = fileTreeStore;
    this._rootKey = rootKey;
    this._nodesToTraverse = [];
    this._currentlyTraversedNode = nodeKey;
    this._limit = limit;
    this._numNodesTraversed = 0;
    this._promise = null;
    this._count = 0;
  }

  _handlePromiseResolution(childrenKeys: Array<NuclideUri>): void {
    this._numNodesTraversed += childrenKeys.length;
    if (this._numNodesTraversed < this._limit) {
      const nextLevelNodes = childrenKeys.filter(childKey => FileTreeHelpers.isDirKey(childKey));
      this._nodesToTraverse = this._nodesToTraverse.concat(nextLevelNodes);

      this._currentlyTraversedNode = this._nodesToTraverse.splice(0, 1)[0];
      this._promise = null;
    } else {
      this._currentlyTraversedNode = null;
      this._promise = null;
    }

    return;
  }

  next(): ?Promise<void> {
    const currentlyTraversedNode = this._currentlyTraversedNode;
    if (!this._promise && currentlyTraversedNode) {
      this._promise = this._fileTreeStore.promiseNodeChildKeys(
        this._rootKey,
        currentlyTraversedNode)
      .then(this._handlePromiseResolution.bind(this));
    }
    return this._promise;
  }

  traversedNode(): ?string {
    return this._currentlyTraversedNode;
  }
}