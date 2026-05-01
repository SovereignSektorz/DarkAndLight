/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IOnboardingService } from '../common/onboardingService.js';
import { DarkMatterOnboarding } from './darkMatterOnboarding.js';

registerSingleton(IOnboardingService, DarkMatterOnboarding, InstantiationType.Delayed);

// -- Auto-show onboarding on first launch ------------------------------
// ONBOARDING DISABLED — re-enable when onboarding dialog is ready
// To re-enable: restore the DarkMatterOnboardingTrigger class, its
// registerWorkbenchContribution2 call, and the registerAction2 command
// palette entry.  See git history for the original implementation.
