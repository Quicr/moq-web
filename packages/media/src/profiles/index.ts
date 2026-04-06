// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Profile exports
 */

export {
  type ExperienceProfileName,
  type DefinedProfileName,
  type ExperienceProfileSettings,
  type ExperienceProfile,
  EXPERIENCE_PROFILES,
  EXPERIENCE_PROFILE_ORDER,
  getExperienceProfile,
  profileFromTargetLatency,
  detectCurrentProfile,
} from './experience-profiles.js';
