/* eslint-disable */
/**
 * @author Kuitos
 * @since 2020-10-13
 */

import { QiankunError } from '@qiankunjs/shared';
import type { noop } from 'lodash';
import { nativeDocument, nativeGlobal, qiankunHeadTagName } from '../../consts';
import { rebindTarget2Fn } from '../../core/membrane/utils';
import type { Sandbox } from '../../core/sandbox';
import type { Free } from '../types';
import {
  calcAppCount,
  getContainerBodyElement,
  getContainerHeadElement,
  getNewRemoveChild,
  getOverwrittenAppendChildOrInsertBefore,
  isAllAppsUnmounted,
  rebuildCSSRules,
  recordStyledComponentsCSSRules,
  styleElementRefNodeNo,
  styleElementTargetSymbol,
} from './common';
import type { SandboxConfig } from './types';

const elementAttachedSymbol = Symbol('attachedApp');
declare global {
  interface HTMLElement {
    [elementAttachedSymbol]: string;
  }

  interface Window {
    __sandboxConfigWeakMap__?: WeakMap<Sandbox, SandboxConfig>;
    __currentLockingSandbox__?: Sandbox;
  }

  interface Document {
    [p: string]: unknown;
  }
}

// Get native global window with a sandbox disgusted way, thus we could share it between qiankun instances🤪
Object.defineProperty(nativeGlobal, '__sandboxConfigWeakMap__', { enumerable: false, writable: true });

Object.defineProperty(nativeGlobal, '__currentLockingSandbox__', {
  enumerable: false,
  writable: true,
  configurable: true,
});

// Share sandboxConfigWeakMap between multiple qiankun instance, thus they could access the same record
nativeGlobal.__sandboxConfigWeakMap__ = nativeGlobal.__sandboxConfigWeakMap__ || new WeakMap<Sandbox, SandboxConfig>();
const sandboxConfigWeakMap = nativeGlobal.__sandboxConfigWeakMap__;

const elementAttachSandboxConfigMap = new WeakMap<HTMLElement, SandboxConfig>();
const patchCacheWeakMap = new WeakMap<object, unknown>();

const getSandboxConfig = (element: HTMLElement) => elementAttachSandboxConfigMap.get(element);

function patchDocument(sandbox: Sandbox, getContainer: () => HTMLElement): CallableFunction {
  const container = getContainer();
  if (patchCacheWeakMap.has(container)) {
    return () => {};
  }

  const unpatch = patchDocumentHeadAndBodyMethods(container);

  const attachElementToSandbox = (element: HTMLElement) => {
    const sandboxConfig = sandboxConfigWeakMap.get(sandbox);
    if (sandboxConfig) {
      elementAttachSandboxConfigMap.set(element, sandboxConfig);
    }
  };
  const getDocumentHeadElement = () => {
    const container = getContainer();
    const containerHeadElement = getContainerHeadElement(container);
    if (!containerHeadElement) {
      throw new QiankunError(`${sandbox.name} head element not existed while accessing document.head!`);
    }
    return containerHeadElement;
  };
  const getDocumentBodyElement = () => {
    const container = getContainer();
    return getContainerBodyElement(container);
  };
  const proxyDocument = new Proxy(document, {
    set: (target, p, value) => {
      target[p as keyof Document] = value;
      return true;
    },
    get: (target, p, receiver) => {
      switch (p) {
        case 'createElement': {
          // Must store the original createElement function to avoid error in nested sandbox
          const targetCreateElement = target.createElement;
          return function createElement(...args: Parameters<typeof document.createElement>) {
            if (!nativeGlobal.__currentLockingSandbox__) {
              nativeGlobal.__currentLockingSandbox__ = sandbox;
            }

            const element = targetCreateElement.call(target, ...args);

            // only record the element which is created by the current sandbox, thus we can avoid the element created by nested sandboxes
            if (nativeGlobal.__currentLockingSandbox__ === sandbox) {
              attachElementToSandbox(element);
              delete nativeGlobal.__currentLockingSandbox__;
            }

            return element;
          };
        }

        case 'head': {
          return getDocumentHeadElement();
        }

        case 'body': {
          return getDocumentBodyElement();
        }

        case 'querySelector': {
          const targetQuerySelector = target.querySelector;
          return function querySelector(...args: Parameters<typeof document.querySelector>) {
            const selector = args[0];
            switch (selector) {
              case 'head': {
                return getDocumentHeadElement();
              }

              case 'body': {
                return getDocumentBodyElement();
              }
            }

            return targetQuerySelector.call(target, ...args);
          };
        }
        default:
          break;
      }

      const value = target[p as string];
      // must rebind the function to the target otherwise it will cause illegal invocation error
      return rebindTarget2Fn(target, value, receiver);
    },
  });

  sandbox.addIntrinsics({
    document: { value: proxyDocument, writable: false, enumerable: true, configurable: true },
  });

  patchCacheWeakMap.set(container, true);

  return () => {
    unpatch();
  };
}

function patchDocumentHeadAndBodyMethods(container: HTMLElement): typeof noop {
  const patchHeadElementMethod = (headElement: HTMLHeadElement) => {
    headElement.appendChild = getOverwrittenAppendChildOrInsertBefore(
      document.head.appendChild,
      getSandboxConfig,
      'head',
    );
    headElement.insertBefore = getOverwrittenAppendChildOrInsertBefore(
      document.head.insertBefore,
      getSandboxConfig,
      'head',
    );
    headElement.removeChild = getNewRemoveChild(document.head.removeChild, getSandboxConfig);
  };
  let containerHeadElement = getContainerHeadElement(container);
  if (!containerHeadElement) {
    // patch container head element after it is mounted
    const observer = new MutationObserver(() => {
      containerHeadElement = getContainerHeadElement(container);
      if (containerHeadElement) {
        patchHeadElementMethod(containerHeadElement);
        observer.disconnect();
      }
    });
    observer.observe(container, { subtree: true, childList: true });
  } else {
    patchHeadElementMethod(containerHeadElement);
  }

  const containerBodyElement = container;
  containerBodyElement.appendChild = getOverwrittenAppendChildOrInsertBefore(
    document.body.appendChild,
    getSandboxConfig,
    'body',
  );
  containerBodyElement.insertBefore = getOverwrittenAppendChildOrInsertBefore(
    document.head.insertBefore,
    getSandboxConfig,
    'body',
  );
  containerBodyElement.removeChild = getNewRemoveChild(document.body.removeChild, getSandboxConfig);

  return () => {
    if (containerHeadElement) {
      // @ts-ignore
      delete containerHeadElement.appendChild;
      // @ts-ignore
      delete containerHeadElement.insertBefore;
      // @ts-ignore
      delete containerHeadElement.removeChild;
    }

    // @ts-ignore
    delete containerBodyElement.appendChild;
    // @ts-ignore
    delete containerBodyElement.insertBefore;
    // @ts-ignore
    delete containerBodyElement.removeChild;
  };
}

function patchDOMPrototypeFns(): typeof noop {
  // patch MutationObserver.prototype.observe to avoid type error
  // https://github.com/umijs/qiankun/issues/2406
  const nativeMutationObserverObserveFn = MutationObserver.prototype.observe;
  if (!patchCacheWeakMap.has(nativeMutationObserverObserveFn)) {
    const observe = function observe(this: MutationObserver, target: Node, options: MutationObserverInit) {
      const realTarget = target instanceof Document ? nativeDocument : target;
      return nativeMutationObserverObserveFn.call(this, realTarget, options);
    };

    MutationObserver.prototype.observe = observe;
    patchCacheWeakMap.set(nativeMutationObserverObserveFn, observe);
  }

  // patch Node.prototype.compareDocumentPosition to avoid type error
  const prevCompareDocumentPosition = Node.prototype.compareDocumentPosition;
  if (!patchCacheWeakMap.has(prevCompareDocumentPosition)) {
    Node.prototype.compareDocumentPosition = function compareDocumentPosition(this: Node, node) {
      const realNode = node instanceof Document ? nativeDocument : node;
      return prevCompareDocumentPosition.call(this, realNode);
    };
    patchCacheWeakMap.set(prevCompareDocumentPosition, Node.prototype.compareDocumentPosition);
  }

  // TODO https://github.com/umijs/qiankun/pull/2415 Not support yet as getCurrentRunningApp api is not reliable
  // patch parentNode getter to avoid document === html.parentNode
  // https://github.com/umijs/qiankun/issues/2408#issuecomment-1446229105
  // const parentNodeDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'parentNode');
  // if (parentNodeDescriptor && !patchCacheWeakMap.has(parentNodeDescriptor)) {
  //   const { get: parentNodeGetter, configurable } = parentNodeDescriptor;
  //   if (parentNodeGetter && configurable) {
  //     const patchedParentNodeDescriptor = {
  //       ...parentNodeDescriptor,
  //       get(this: Node) {
  //         const parentNode = parentNodeGetter.call(this) as HTMLElement;
  //         if (parentNode instanceof Document) {
  //           const proxy = getCurrentRunningApp()?.window;
  //           if (proxy) {
  //             return proxy.document;
  //           }
  //         }
  //
  //         return parentNode;
  //       },
  //     };
  //     Object.defineProperty(Node.prototype, 'parentNode', patchedParentNodeDescriptor);
  //
  //     patchCacheWeakMap.set(parentNodeDescriptor, patchedParentNodeDescriptor);
  //   }
  // }

  return () => {
    MutationObserver.prototype.observe = nativeMutationObserverObserveFn;
    patchCacheWeakMap.delete(nativeMutationObserverObserveFn);

    Node.prototype.compareDocumentPosition = prevCompareDocumentPosition;
    patchCacheWeakMap.delete(prevCompareDocumentPosition);

    // if (parentNodeDescriptor) {
    //   Object.defineProperty(Node.prototype, 'parentNode', parentNodeDescriptor);
    //   patchCacheWeakMap.delete(parentNodeDescriptor);
    // }
  };
}

// FIXME should not use global variable, should get it every time it is used, otherwise it may miss the runtime container or the business itself monkey patch logic
const rawHeadInsertBefore = HTMLHeadElement.prototype.insertBefore;
const rawHeadAppendChild = HTMLHeadElement.prototype.appendChild;

export function patchStandardSandbox(
  appName: string,
  getContainer: () => HTMLElement,
  opts: {
    sandbox: Sandbox;
    mounting?: boolean;
  },
): Free {
  const { sandbox, mounting = true } = opts;
  let sandboxConfig = sandboxConfigWeakMap.get(sandbox);
  if (!sandboxConfig) {
    sandboxConfig = {
      appName,
      sandbox,
      dynamicStyleSheetElements: [],
      dynamicExternalSyncScriptElements: [],
    };
    sandboxConfigWeakMap.set(sandbox, sandboxConfig);
  }
  // all dynamic style sheets are stored in proxy container
  const { dynamicStyleSheetElements } = sandboxConfig;

  const unpatchDocument = patchDocument(sandbox, getContainer);
  const unpatchDOMPrototype = patchDOMPrototypeFns();

  if (!mounting) calcAppCount(appName, 'increase', 'bootstrapping');
  if (mounting) calcAppCount(appName, 'increase', 'mounting');

  return function free() {
    if (!mounting) calcAppCount(appName, 'decrease', 'bootstrapping');
    if (mounting) calcAppCount(appName, 'decrease', 'mounting');

    // release the overwritten document
    unpatchDocument();

    // release the overwritten prototype after all the micro apps unmounted
    if (isAllAppsUnmounted()) {
      unpatchDOMPrototype();
    }

    recordStyledComponentsCSSRules(dynamicStyleSheetElements as HTMLStyleElement[]);

    // As now the sub app content all wrapped with a special id container,
    // the dynamic style sheet could be removed automatically while unmounting
    return function rebuild() {
      const container = getContainer();
      rebuildCSSRules(dynamicStyleSheetElements as HTMLStyleElement[], (stylesheetElement) => {
        if (!container.contains(stylesheetElement)) {
          const mountDom =
            stylesheetElement[styleElementTargetSymbol] === 'head'
              ? (() => {
                  const containerHeadElement = getContainerHeadElement(container);
                  if (!containerHeadElement) {
                    throw new QiankunError(
                      `${appName} container ${qiankunHeadTagName} element not ready while rebuilding!`,
                    );
                  }
                  return containerHeadElement;
                })()
              : container;

          const refNo = stylesheetElement[styleElementRefNodeNo];
          if (typeof refNo === 'number' && refNo !== -1) {
            // the reference node may be dynamic script comment which is not rebuilt while remounting thus reference node no longer exists
            // in this case, we should append the style element to the end of mountDom
            const refNode = mountDom.childNodes[refNo];
            rawHeadInsertBefore.call(mountDom, stylesheetElement, refNode);
            return true;
          }

          rawHeadAppendChild.call(mountDom, stylesheetElement);
          return true;
        }

        return false;
      });
    };
  };
}
