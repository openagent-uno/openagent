"""Existing desktop credentials and proof bytes survive the SRP dependency update."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from openagent_identity.coordinator.pake import Srp6aBackend, Srp6aClientLogin, PakeError

FIXTURE = Path(__file__).resolve().parents[1] / 'apps/app/desktop/src/network/__tests__/srp.fixture.json'

class PakeWireCompatibilityTests(unittest.TestCase):
    def test_existing_desktop_record_and_proofs_round_trip(self):
        f=json.loads(FIXTURE.read_text())
        record=bytes.fromhex(f['register_payload'])
        backend=Srp6aBackend()
        self.assertEqual(backend.register_finalize(f['handle'],record),record)
        with patch('secrets.token_hex',return_value=f['server_b_priv']):
            state,response=backend.login_init(f['handle'],record,bytes.fromhex(f['ke1_A']))
        self.assertEqual(response.hex(),f['server_response'])
        client=Srp6aClientLogin(f['handle'],f['password'],f['client_a_priv'],bytes.fromhex(f['ke1_A']))
        proof=client.respond(response)
        self.assertEqual(proof.hex(),f['expected_M1'])
        server_proof=backend.login_finish(state,proof)
        self.assertEqual(server_proof.hex(),f['expected_M2'])
        client.verify_server(server_proof)

    def test_invalid_client_proof_remains_rejected(self):
        f=json.loads(FIXTURE.read_text());backend=Srp6aBackend()
        state,_=backend.login_init(f['handle'],bytes.fromhex(f['register_payload']),bytes.fromhex(f['ke1_A']))
        for proof in (b'0'*64,b'\xff'*64):
            with self.subTest(proof=proof),self.assertRaises(PakeError):backend.login_finish(state,proof)

if __name__=='__main__':unittest.main()
