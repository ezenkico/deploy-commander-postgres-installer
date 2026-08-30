import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css'
import { createWire, type Events, RPC, type RPCResponse, type WireSend } from "@ezenki/deploy-commander-installer-interface";
import Install from './components/Install';
import Teardown from './components/Teardown';
import { createRunEventSource } from './lib/runMonitor';
import { recoverConnectionOnBoot, type AppClient } from './lib/appRecovery';

function setupWire(
  sendAction: (wire: WireSend) => Promise<RPCResponse>,
  eventAction: (event: Events.InterfaceEvent) => void
){
  const events = createRunEventSource();
  const wire = createWire(
    sendAction,
    (event) => {
      events.publish(event);
      eventAction(event);
    }
  );
  return { wire, caller: RPC.SetupRPCCaller(wire), events };
}

function checkRuns(runs: RPC.GetRuns){
  if(runs.items.length < 1){
    return true;
  }
  if(runs.items[0].action === "teardown"){
    return true;
  }
  return false;
}

export default function App() {
  const [first, setFirst] = useState(false);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const currentRun = useRef<string | null>(null);
  const client = useRef<AppClient>(setupWire(async(wire: WireSend) => {
    void wire;
    return {
      ok: true,
      result: null
    }
  }, (event) => {
    if(event.eventType === "run-update"){
      const data = event.data;
      if(data.type === "event"){
        const status = data.payload.status;
        if(status && (status === 2 || status === 3)){
          checkRun().finally(() => {
            setRunning(false);
          });
        }
      }
      return;
    }
    const runID = event.data.id;
    if(runID === currentRun.current){
      return;
    }
    currentRun.current = runID;
    setRunning(true);
  }));
  const caller = client.current.caller;
  const checkRun = useCallback(async () => {
      const run = await caller.getRuns(undefined, undefined, undefined, undefined, 1);
      setFirst(checkRuns(run));
    }, [])

  useEffect(() => {
    recoverConnectionOnBoot(client.current).then((result) => {
      if (result?.kind === 'busy') setRunning(true);
      return checkRun();
    }).catch(() => {
      setRunning(true);
    }).finally(() => {
      setLoading(false);
    });
  }, [])

  if(loading){
    return <div>Loading</div>
  }

  if(running){
    return <div>Running</div>
  }

  return (
    <div className="p-6 text-xl font-semibold">
      {first ? (
        <Install wire={caller}/>
      ) : (
        <Teardown wire={caller}/>
      )}
    </div>
  )
}
