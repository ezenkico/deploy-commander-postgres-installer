import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";

interface InstallProps{
    wire: RPCCaller
}

export default function Teardown({wire}: InstallProps){
    return <button onClick={() => {
        wire.start(
          "teardown", 
          "ezenki/deploy-commander-runner:latest",
          {
          }
        ).then(() => {
          console.log("started")
        })
        .catch((error) => {
          console.log(error);
        });
      }}>Teardown</button>
}