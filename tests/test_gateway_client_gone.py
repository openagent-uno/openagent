"""A client that drops its connection is not reported as a server error."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from openagent_server.gateway import server


class HandlerFailureLogTests(unittest.TestCase):
    request = SimpleNamespace(path="/ws/collaboration", method="GET")

    def _report(self, exc):
        with patch.object(server, "elog") as log:
            try:
                raise exc
            except Exception as caught:
                server.report_handler_failure(self.request, caught)
        return log.call_args

    def test_a_client_that_went_away_is_noted_without_a_traceback(self):
        for exc in (ConnectionResetError("Connection lost"), ConnectionResetError()):
            call = self._report(exc)
            self.assertEqual(("gateway.client_gone",), call.args)
            self.assertEqual({"path": "/ws/collaboration", "method": "GET"}, call.kwargs)

    def test_any_other_failure_is_still_an_error_with_its_traceback(self):
        for exc in (RuntimeError("boom"), ConnectionRefusedError("upstream down"), OSError("disk")):
            call = self._report(exc)
            self.assertEqual(("gateway.rest_error",), call.args)
            self.assertEqual("error", call.kwargs["level"])
            self.assertTrue(call.kwargs["exc_info"])
            self.assertEqual(str(exc), call.kwargs["error"])


if __name__ == "__main__":
    unittest.main()
