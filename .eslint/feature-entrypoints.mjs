import fs from 'node:fs';
import path from 'node:path';

// Paths in this catalog are the only cross-feature component imports that are
// public. A folder entry is named without its index file extension.
export const appPublicEntries = new Set([
  'app/components/Auth',
  'app/components/common/AmountInput',
  'app/components/common/CalendarPicker',
  'app/components/common/CardWrapper',
  'app/components/common/CloseButton',
  'app/components/common/ConfirmModal',
  'app/components/common/CovaultIcon',
  'app/components/common/DashboardBottomBar',
  'app/components/common/EmptyState',
  'app/components/common/ErrorBoundary',
  'app/components/common/FullScreenLoader',
  'app/components/common/NoticeModal',
  'app/components/common/OwnerDisc',
  'app/components/common/PageShell',
  'app/components/common/ParsingCard',
  'app/components/common/Portal',
  'app/components/common/SectionHeader',
  'app/components/common/SettingsCard',
  'app/components/common/ToggleSwitch',
  'app/components/Dashboard',
  'app/components/Dashboard/DashboardBalanceSection',
  'app/components/Dashboard/DashboardBudgetSectionsList',
  'app/components/notifications',
  'app/components/notifications/CaptureSourcePicker',
  'app/components/notifications/FirstCaptureModal',
  'app/components/notifications/NotificationAccessGuide',
  'app/components/Onboarding',
  'app/components/review',
  'app/components/settings',
  'app/components/subscription',
  'app/components/subscription/PremiumGate',
  'app/components/tour',
  'app/components/tour/TourDemoScreen',
  'app/components/transactions',
  'app/components/transactions/TransactionActionModal',
  'app/components/transactions/TransactionItem',
  'app/components/transactions/householdPeople',
  'app/components/updates',
]);

const legalLazyEntries = new Set([
  'app/components/legal/PrivacyPolicy',
  'app/components/legal/Terms',
  'app/components/legal/DeleteAccountRequest',
]);

const chartPath = 'app/components/Dashboard/BudgetFlowChart';
const chartLazyImporters = new Set([
  'app/components/Dashboard/Dashboard.tsx',
  'app/components/tour/TourDemoScreen.tsx',
]);

const sourceExtensions = ['.tsx', '.ts', '.jsx', '.js'];
const indexFileNames = sourceExtensions.map(extension => `index${extension}`);

function importerPath(context) {
  return path.relative(context.cwd, context.filename).split(path.sep).join('/');
}

function resolveTarget(importer, source) {
  if (typeof source?.value !== 'string') return undefined;
  const specifier = source.value;
  if (specifier.startsWith('@/')) return specifier.slice(2);
  if (specifier.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  return undefined;
}

function normalizedTarget(target) {
  return target.replace(/\.(?:tsx?|jsx?)$/, '').replace(/\/index$/, '').replace(/\/$/, '');
}

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function findIndexFile(directory) {
  return indexFileNames.map(fileName => path.join(directory, fileName)).find(candidate => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function resolveExistingModule(target) {
  const candidates = [
    target,
    ...sourceExtensions.map(extension => `${target}${extension}`),
    ...indexFileNames.map(fileName => path.join(target, fileName)),
  ];

  return candidates.find(candidate => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function componentOwnerForModule(context, source) {
  const importer = importerPath(context);
  const target = resolveTarget(importer, source);
  if (!target) return undefined;

  const componentsRoot = path.resolve(context.cwd, 'app/components');
  const resolvedFile = resolveExistingModule(path.resolve(context.cwd, target));
  if (!resolvedFile || !isWithinDirectory(componentsRoot, resolvedFile)) return undefined;

  let directory = path.dirname(resolvedFile);
  while (isWithinDirectory(componentsRoot, directory)) {
    const indexPath = findIndexFile(directory);
    const componentName = path.basename(directory);
    const implementationPath = sourceExtensions
      .map(extension => path.join(directory, `${componentName}${extension}`))
      .find(candidate => {
        try {
          return fs.statSync(candidate).isFile();
        } catch {
          return false;
        }
      });

    if (indexPath && implementationPath) {
      return {
        entry: path.relative(context.cwd, directory).split(path.sep).join('/'),
        directory,
        isEntry: path.resolve(indexPath) === path.resolve(resolvedFile),
        isImplementation: path.resolve(implementationPath) === path.resolve(resolvedFile),
      };
    }

    if (path.resolve(directory) === componentsRoot) break;
    directory = path.dirname(directory);
  }

  return undefined;
}

function featureForTarget(target) {
  if (target.startsWith('components/')) return target.split('/', 2)[1];
  if (target === 'app/components') return 'components';
  if (target.startsWith('app/components/')) return target.split('/', 3)[2];
  return undefined;
}

function namespaceForTarget(target) {
  if (target.startsWith('components/')) return 'components';
  if (target === 'app/components' || target.startsWith('app/components/')) return 'app/components';
  return undefined;
}

function isCommonHelperTarget(target) {
  if (!target.startsWith('app/components/common/')) return false;
  const parts = normalizedTarget(target).split('/');
  return parts.length === 4 && /^[a-z]/.test(parts[3]);
}

function isTypeOnly(node, declarationTypeOnly = false) {
  if (declarationTypeOnly || node?.importKind === 'type' || node?.exportKind === 'type') return true;
  return node?.specifiers?.length > 0 && node.specifiers.every(specifier =>
    specifier.importKind === 'type' || specifier.exportKind === 'type');
}

function featureRuleCheck(context, node, source, typeOnly = false, lazy = false) {
  if (typeOnly || typeof source?.value !== 'string') return;
  const importer = importerPath(context);
  const target = resolveTarget(importer, source);
  if (!target || isCommonHelperTarget(target)) return;

  const normalized = normalizedTarget(target);
  const namespace = namespaceForTarget(normalized);
  const feature = featureForTarget(normalized);
  if (namespace === 'components') {
    context.report({ node, messageId: 'privateImport', data: { feature: feature ?? 'components' } });
    return;
  }
  if (!namespace) return;

  const importerNamespace = namespaceForTarget(importer);
  const importerFeature = featureForTarget(importer);

  if (normalized === chartPath || normalized.startsWith(`${chartPath}/`)) {
    if (normalized === chartPath && lazy && chartLazyImporters.has(importer)) return;
    context.report({ node, messageId: 'privateImport', data: { feature: 'Dashboard' } });
    return;
  }

  const legalEntry = [...legalLazyEntries].find(entry => normalized === entry || normalized.startsWith(`${entry}/`));
  if (legalEntry) {
    if (normalized === legalEntry && lazy && importer === 'app/index.tsx') return;
    context.report({ node, messageId: 'privateImport', data: { feature: 'legal' } });
    return;
  }

  const componentOwner = componentOwnerForModule(context, source);
  const catalogTarget = componentOwner?.isEntry ? componentOwner.entry : normalized;

  if (namespace === importerNamespace && feature && feature === importerFeature) return;
  if (appPublicEntries.has(catalogTarget)) return;

  context.report({
    node,
    messageId: 'privateImport',
    data: { feature: feature ?? 'components' },
  });
}

function implementationRuleCheck(context, node, source, typeOnly = false) {
  if (typeOnly || typeof source?.value !== 'string') return;
  const owner = componentOwnerForModule(context, source);
  if (!owner || owner.isEntry || !owner.isImplementation) return;

  const importer = path.resolve(context.cwd, importerPath(context));
  if (isWithinDirectory(owner.directory, importer)) return;

  context.report({ node, messageId: 'implementationImport' });
}

function makeRule(check, description, messages) {
  return {
    meta: {
      type: 'problem',
      docs: { description },
      schema: [],
      messages,
    },
    create(context) {
      return {
        ImportDeclaration(node) {
          check(context, node, node.source, isTypeOnly(node));
        },
        ImportExpression(node) {
          check(context, node, node.source, false, true);
        },
        ExportNamedDeclaration(node) {
          check(context, node, node.source, isTypeOnly(node));
        },
        ExportAllDeclaration(node) {
          check(context, node, node.source, isTypeOnly(node));
        },
      };
    },
  };
}

const featureEntryRule = makeRule(
  featureRuleCheck,
  'Import another feature through its explicit public component entry point.',
  {
    privateImport: 'Use the public entry point for {{feature}}. Its supporting files belong to that feature.',
  },
);

const componentImplementationRule = makeRule(
  implementationRuleCheck,
  'Import an owned component through its folder entry point, not its implementation file.',
  {
    implementationImport: 'Import through the component folder entry; implementation files stay within their component folder.',
  },
);

export default {
  rules: {
    'feature-entrypoints': featureEntryRule,
    'component-implementation-entrypoints': componentImplementationRule,
  },
};
