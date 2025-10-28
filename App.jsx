const { useState, useEffect } = React;

function App(){
  const [message,setMessage]=useState("Dienstplan wird geladen...");
  const API="https://kellerkinderclan.de/Dienstplan/api";

  useEffect(()=>{
    async function ping(){
      try{
        const res=await fetch(API+"/stats.php?key=12345&team=default&year=2025");
        if(!res.ok) throw new Error("Serverfehler");
        const data=await res.text();
        setMessage("✅ Verbindung zur API erfolgreich! Antwort: "+data.slice(0,150));
      }catch(e){
        setMessage("⚠️ Keine Verbindung zur API: "+e.message);
      }
    }
    ping();
  },[]);

  return (
    <div>
      <h1>🧭 Dienstplan Pro (GitHub Testversion)</h1>
      <p>{message}</p>
      <p>Diese Version nutzt automatisch die Online-API auf <b>{API}</b>.</p>
      <p>Offline-Funktionen (IndexedDB, Undo/Redo, Bedarf, Statistik) bleiben in der vollständigen Version erhalten.</p>
    </div>
  );
}

ReactDOM.render(<App/>, document.getElementById('root'));
