'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import nuclideUri from '../../commons-node/nuclideUri';
import {getMountedReactRootNames} from '../../commons-atom/testHelpers';

/**
 * Activates all nuclide and fb atom packages that do not defer their own activation until a
 * certain command or hook is executed.
 *
 * @returns A promise that resolves to an array of strings, which are the names of all the packages
 *   that this function activates.
 */
export async function activateAllPackages(): Promise<Array<string>> {
  // These are packages we want to activate, including some which come bundled with atom,
  // or ones widely used in conjunction with nuclide.
  const whitelist = [
    'autocomplete-plus',
    'hyperclick',
    'status-bar',
    'tool-bar',
  ];

  // Manually call `triggerDeferredActivationHooks` since Atom doesn't call it via
  // `atom.packages.activate()` during tests. Calling this before we activate
  // Nuclide packages sets `deferredActivationHooks` to `null`, so that deferred
  // activation hooks are triggered as needed instead of batched.
  // https://github.com/atom/atom/blob/v1.8.0/src/package-manager.coffee#L467-L472
  atom.packages.triggerDeferredActivationHooks();

  const packageNames = atom.packages.getAvailablePackageNames().filter(name => {
    const pack = atom.packages.loadPackage(name);
    if (pack == null) {
      return false;
    }
    const isActivationDeferred = pack.hasActivationCommands() || pack.hasActivationHooks();
    const isLanguagePackage = name.startsWith('language-');
    const inWhitelist = whitelist.indexOf(name) >= 0;
    return (isLanguagePackage || inWhitelist) && !isActivationDeferred;
  });

  // Include the path to the nuclide package.
  packageNames.push(nuclideUri.dirname(require.resolve('../../../package.json')));
  // Include the path to the tool-bar package
  packageNames.push(nuclideUri.join(String(process.env.ATOM_HOME), 'packages/tool-bar'));

  await Promise.all(packageNames.map(pack => atom.packages.activatePackage(pack)));
  return atom.packages.getActivePackages().map(pack => pack.name);
}

export function deactivateAllPackages(): void {
  atom.packages.getActivePackages().map(pack => {
    // TODO: Atom does not unregister its activation hooks on package deactivation!
    // Do it manually until https://github.com/atom/atom/pull/12237 is merged.
    if (pack.activationHookSubscriptions != null) {
      pack.activationHookSubscriptions.dispose();
    }
  });

  atom.packages.deactivatePackages();
  atom.packages.unloadPackages();

  const mountedReactRootNames = getMountedReactRootNames();
  mountedReactRootNames.forEach(rootDisplayName => {
    // eslint-disable-next-line no-console
    console.error(
      'Found a mounted React component. ' +
      `Did you forget to call React.unmountComponentAtNode on "${rootDisplayName}"?`,
    );
  });

  expect(mountedReactRootNames.length).toBe(0);
}
