// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview URL module exports
 */

// Encoder
export {
  NamespaceEncoderError,
  encodeElement,
  decodeElement,
  encodeNamespace,
  decodeNamespace,
  encodeTrackReference,
  decodeTrackReference,
  type TrackReference,
} from './encoder.js';

// Parser
export {
  MsfUrlError,
  parseMsfUrl,
  generateMsfUrl,
  generateCatalogUrl,
  extractTrackReference,
  buildFragment,
  buildNamespaceFragment,
  type MsfUrl,
} from './parser.js';

// Variable substitution (§8)
export {
  VariableSubstitutionError,
  parseFragmentVariables,
  serializeFragmentVariables,
  substituteVariables,
  substituteVariablesDeep,
  extractVariableNames,
  isValidVariableName,
  isValidVariableValue,
} from './variables.js';
