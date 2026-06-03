//! Canonical numbering registry for Sonari TEE verifiers.
//!
//! This is the single in-code source of truth for the per-verifier numbering
//! (`family` / `config_key` / attestation public-key label) that the human
//! numbering table in `nautilus/verifiers/README.md` mirrors. Keeping it here
//! lets the uniqueness tests prove that no two verifiers share a `config_key`
//! or attestation label, and lets the verifier crates depend on these plain
//! constants instead of re-declaring their own copies.
//!
//! These are plain `u8` / `u64` / byte-string constants. The shared crate must
//! never depend on a verifier crate: the numbering flows shared -> verifier,
//! never the reverse.
//!
//! ## Numbering rule
//!
//! `config_key` (u64) is assigned sequentially, one per verifier, and is never
//! reused. earthquake = 1, identity = 2, and the next verifier reserves
//! [`NEXT_VERIFIER_CONFIG_KEY`] (= 3). The `family` (u8) values mirror the Move
//! `metadata_verifier` module (earthquake oracle = 3, identity = 4).

/// `config_key` for the earthquake (USGS oracle) verifier family.
pub const EARTHQUAKE_VERIFIER_CONFIG_KEY: u64 = 1;

/// `config_key` for the identity (membership) verifier family.
pub const IDENTITY_VERIFIER_CONFIG_KEY: u64 = 2;

/// Reserved `config_key` for the next verifier added to the shared registry.
///
/// The numbering rule assigns the next sequential key (+1 above the highest
/// registered key); update this and append a [`VERIFIER_REGISTRY`] entry when a
/// third verifier lands.
pub const NEXT_VERIFIER_CONFIG_KEY: u64 = 3;

/// Attestation public-key label for the earthquake verifier enclave.
pub const EARTHQUAKE_ATTESTATION_PUBLIC_KEY_LABEL: &[u8] =
    b"sonari-earthquake-attestation-public-key";

/// Attestation public-key label for the identity (membership) verifier enclave.
pub const IDENTITY_ATTESTATION_PUBLIC_KEY_LABEL: &[u8] =
    b"sonari-membership-attestation-public-key";

/// How a verifier's intent / domain-separation marker is represented on the
/// signed payload.
///
/// The two families use structurally different intent encodings, so the
/// registry records the shape rather than a single value: earthquake prefixes
/// its BCS payload with a `u8` enum tag, while identity prefixes a UTF-8 intent
/// string. Both ultimately serve the same domain-separation role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifierIntent {
    /// A `u8` BCS enum tag at the head of the payload (earthquake).
    EnumTag(u8),
    /// A UTF-8 intent string at the head of the payload (identity).
    Utf8String(&'static str),
}

/// One row of the canonical verifier numbering table.
#[derive(Debug, Clone, Copy)]
pub struct VerifierRegistryEntry {
    /// Short verifier name (matches the README numbering table row).
    pub name: &'static str,
    /// Move `verifier_family` (u8) value (see `metadata_verifier.move`).
    pub family: u8,
    /// `verifier_config_key` (u64) in the on-chain `VerifierRegistry`.
    pub config_key: u64,
    /// Attestation public-key label bound into the NSM attestation document.
    pub attestation_public_key_label: &'static [u8],
    /// Intent / domain-separation marker shape for the signed payload.
    pub intent: VerifierIntent,
}

/// The canonical, single source of truth for verifier numbering.
///
/// The README numbering table mirrors these rows. Adding a verifier appends one
/// row here (and bumps [`NEXT_VERIFIER_CONFIG_KEY`]).
pub const VERIFIER_REGISTRY: &[VerifierRegistryEntry] = &[
    VerifierRegistryEntry {
        name: "earthquake",
        family: 3,
        config_key: EARTHQUAKE_VERIFIER_CONFIG_KEY,
        attestation_public_key_label: EARTHQUAKE_ATTESTATION_PUBLIC_KEY_LABEL,
        intent: VerifierIntent::EnumTag(1),
    },
    VerifierRegistryEntry {
        name: "identity",
        family: 4,
        config_key: IDENTITY_VERIFIER_CONFIG_KEY,
        attestation_public_key_label: IDENTITY_ATTESTATION_PUBLIC_KEY_LABEL,
        intent: VerifierIntent::Utf8String("SONARI_IDENTITY_VERIFICATION_V1"),
    },
];

#[cfg(test)]
mod tests {
    use super::{
        EARTHQUAKE_ATTESTATION_PUBLIC_KEY_LABEL, EARTHQUAKE_VERIFIER_CONFIG_KEY,
        IDENTITY_ATTESTATION_PUBLIC_KEY_LABEL, IDENTITY_VERIFIER_CONFIG_KEY,
        NEXT_VERIFIER_CONFIG_KEY, VERIFIER_REGISTRY,
    };
    use std::collections::HashSet;

    #[test]
    fn config_keys_are_unique_across_the_registry() {
        let mut seen = HashSet::new();
        for entry in VERIFIER_REGISTRY {
            assert!(
                seen.insert(entry.config_key),
                "duplicate verifier config_key {} for {}",
                entry.config_key,
                entry.name,
            );
        }
    }

    #[test]
    fn attestation_labels_are_unique_across_the_registry() {
        let mut seen = HashSet::new();
        for entry in VERIFIER_REGISTRY {
            assert!(
                seen.insert(entry.attestation_public_key_label),
                "duplicate attestation label {:?} for {}",
                entry.attestation_public_key_label,
                entry.name,
            );
        }
    }

    #[test]
    fn registry_matches_the_published_numbering_values() {
        let earthquake = VERIFIER_REGISTRY
            .iter()
            .find(|entry| entry.name == "earthquake")
            .expect("earthquake entry");
        assert_eq!(earthquake.family, 3);
        assert_eq!(earthquake.config_key, EARTHQUAKE_VERIFIER_CONFIG_KEY);
        assert_eq!(earthquake.config_key, 1);
        assert_eq!(
            earthquake.attestation_public_key_label,
            EARTHQUAKE_ATTESTATION_PUBLIC_KEY_LABEL,
        );
        assert_eq!(
            earthquake.attestation_public_key_label,
            b"sonari-earthquake-attestation-public-key",
        );

        let identity = VERIFIER_REGISTRY
            .iter()
            .find(|entry| entry.name == "identity")
            .expect("identity entry");
        assert_eq!(identity.family, 4);
        assert_eq!(identity.config_key, IDENTITY_VERIFIER_CONFIG_KEY);
        assert_eq!(identity.config_key, 2);
        assert_eq!(
            identity.attestation_public_key_label,
            IDENTITY_ATTESTATION_PUBLIC_KEY_LABEL,
        );
        assert_eq!(
            identity.attestation_public_key_label,
            b"sonari-membership-attestation-public-key",
        );
    }

    #[test]
    fn next_config_key_is_reserved_above_every_registered_key() {
        for entry in VERIFIER_REGISTRY {
            assert!(
                NEXT_VERIFIER_CONFIG_KEY > entry.config_key,
                "next config_key {} must exceed registered key {} for {}",
                NEXT_VERIFIER_CONFIG_KEY,
                entry.config_key,
                entry.name,
            );
        }
        // The numbering rule reserves +1 after the highest registered key.
        assert_eq!(NEXT_VERIFIER_CONFIG_KEY, 3);
    }
}
