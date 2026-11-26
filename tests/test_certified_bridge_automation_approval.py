"""A private bridge can renew a reviewed task with an exact set of durable sources."""
import pytest

from openagent_core.automation import build_automation_toolkit
from openagent_core.runtime import execution_scope
from test_certified_bridge_child_history import certified_bridge


@pytest.mark.asyncio
async def test_private_approval_preserves_the_certified_principal_and_selected_sources(tmp_path, monkeypatch):
    async with certified_bridge(tmp_path, monkeypatch) as fixture:
        service = fixture.service
        caller = await service.context(fixture.request, "tg:100")
        assert caller.initiator.subject_id == fixture.request["device_cert"].handle
        task_id = await fixture.db.add_task("Review fixture", "1 1 1 1 *", "Summarize a neutral fixture.")
        tools = build_automation_toolkit("scheduled_task").async_functions
        review = tools["review_scheduled_task_authorization"].entrypoint
        approve = tools["approve_scheduled_task_authorization"].entrypoint
        with execution_scope(service.runtime, caller, "management-turn"):
            revision = await review(task_id)
            assert not revision["authorized"]
            available = revision["capabilities"]["grantable"]
            assert len(available) >= 2
            for selected in ([available[0]], []):
                approval = await approve(task_id, revision["digest"], sources=selected)
                assert approval["authorized"]
                assert (await review(task_id))["capabilities"]["granted"] == selected
                definition = await service.automations.definition("task", task_id)
                deferred = await service.automations.resolve("task", definition, "occurrence", "worker")
                assert deferred.initiator == caller.initiator
                assert deferred.authority == caller.authority
                assert deferred.audience == caller.audience
                assert {s for s in deferred.scopes if s.startswith("capability:")} == {
                    "capability:" + source for source in selected
                }
