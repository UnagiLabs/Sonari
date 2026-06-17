use base64ct::{Base64, Encoding};
use census_tee::validator_committee_digest;
use sui_crypto::bls12381::{Bls12381PrivateKey, ValidatorCommitteeSignatureAggregator};
use sui_sdk_types::{
    Address, CheckpointCommitment, CheckpointSummary, Digest, GasCostSummary, Identifier,
    MoveStruct, Object, ObjectData, Owner, StructTag, ValidatorCommittee, ValidatorCommitteeMember,
};

pub struct AuthenticatedProofJson {
    pub proof: serde_json::Value,
    pub trusted_validator_committee_digest: String,
}

pub fn authenticated_event_proof_json() -> AuthenticatedProofJson {
    let tree_root = Digest::new([0x78; 32]);
    let object_id = Address::new([0x34; 32]);
    let mut contents = object_id.into_inner().to_vec();
    contents.extend_from_slice(b"event-stream-head");
    let move_struct = MoveStruct::new(
        StructTag::new(
            Address::new([0x12; 32]),
            Identifier::from_static("authenticated_event"),
            Identifier::from_static("EventStreamHead"),
            Vec::new(),
        ),
        false,
        7,
        contents,
    )
    .expect("EventStreamHead object contents should include an id");
    let event_stream_head = Object::new(
        ObjectData::Struct(move_struct),
        Owner::Shared(1),
        Digest::new([0x99; 32]),
        0,
    );

    let summary = CheckpointSummary {
        epoch: 22,
        sequence_number: 345,
        network_total_transactions: 123,
        content_digest: Digest::new([0x41; 32]),
        previous_digest: Some(Digest::new([0x42; 32])),
        epoch_rolling_gas_cost_summary: GasCostSummary::new(0, 0, 0, 0),
        timestamp_ms: 1_700_000_000_000,
        checkpoint_commitments: vec![CheckpointCommitment::EcmhLiveObjectSet { digest: tree_root }],
        end_of_epoch_data: None,
        version_specific_data: Vec::new(),
    };
    let private_keys = [
        Bls12381PrivateKey::new([1; 32]).expect("test private key should be valid"),
        Bls12381PrivateKey::new([2; 32]).expect("test private key should be valid"),
        Bls12381PrivateKey::new([3; 32]).expect("test private key should be valid"),
        Bls12381PrivateKey::new([4; 32]).expect("test private key should be valid"),
    ];
    let committee = ValidatorCommittee {
        epoch: summary.epoch,
        members: private_keys
            .iter()
            .map(|key| ValidatorCommitteeMember {
                public_key: key.public_key(),
                stake: 1,
            })
            .collect(),
    };
    let mut aggregator =
        ValidatorCommitteeSignatureAggregator::new_checkpoint_summary(committee.clone(), &summary)
            .expect("test committee should be valid");
    for key in private_keys.iter().take(3) {
        aggregator
            .add_signature(key.sign_checkpoint_summary(&summary))
            .expect("test signature should aggregate");
    }
    let signature = aggregator
        .finish()
        .expect("three of four equal stake signatures should meet quorum");
    let committee_bcs = bcs::to_bytes(&committee).expect("committee should BCS encode");

    AuthenticatedProofJson {
        trusted_validator_committee_digest: validator_committee_digest(&committee_bcs).to_string(),
        proof: serde_json::json!({
            "protocol": "sui-authenticated-events-v1",
            "stream_id": format!("0x{}", "12".repeat(32)),
            "event_stream_head_object_id": format!("0x{}", "34".repeat(32)),
            "start_checkpoint": 0,
            "end_checkpoint": 345,
            "highest_indexed_checkpoint": 345,
            "validator_committee_bcs": Base64::encode_string(&committee_bcs),
            "checkpoint_summary_bcs": Base64::encode_string(
                &bcs::to_bytes(&summary).expect("summary should BCS encode"),
            ),
            "checkpoint_signature_bcs": Base64::encode_string(
                &bcs::to_bytes(&signature).expect("signature should BCS encode"),
            ),
            "event_stream_head": {
                "object_id": format!("0x{}", "34".repeat(32)),
                "version": "7",
                "digest": event_stream_head.digest().to_string(),
                "object_bcs": Base64::encode_string(
                    &bcs::to_bytes(&event_stream_head).expect("object should BCS encode"),
                )
            },
            "ocs_proof": {
                "leaf_index": 3,
                "tree_root": tree_root.to_string(),
                "merkle_proof": ["cHJvb2YtMQ=="]
            },
            "events": [
                {
                    "checkpoint": 100,
                    "transaction_index": 0,
                    "event_index": 0,
                    "type": format!("0x{}::membership::MembershipPassIssued", "12".repeat(32)),
                    "event_bcs": "ZXZlbnQtMQ=="
                },
                {
                    "checkpoint": 101,
                    "transaction_index": 0,
                    "event_index": 1,
                    "type": format!("0x{}::membership::HomeCellRegistered", "12".repeat(32)),
                    "event_bcs": "ZXZlbnQtMg=="
                }
            ]
        }),
    }
}
