// CBD Plant & Labour — Interactive Demo Artifact
// This is the renderable version for Claude artifact display
import { useState } from "react";

const C = {
  bg:"#0d0f14",s1:"#13161e",s2:"#1a1e28",s3:"#222636",
  b1:"#2a2f40",b2:"#353a50",t1:"#e8eaf2",t2:"#8b90a8",
  t3:"#5a5f75",ac:"#f97316",gr:"#22c55e",re:"#ef4444",
  ye:"#eab308",bl:"#3b82f6",cy:"#06b6d4",
};
const wColor=(n)=>{const C=["#3b82f6","#8b5cf6","#06b6d4","#22c55e","#f97316","#eab308","#a855f7","#ef4444"];return C[(n||"").charCodeAt(0)%C.length];};
const ini=(n)=>(n||"").split(" ").map(x=>x[0]).join("").substring(0,2).toUpperCase();

const WORKERS=[
  {id:1,name:"James Holloway",role:"Concreter · EWP Operator",status:"on_site",site:"Southern Cross Tower",client:"BuildRight Pty Ltd",app:"Active",cert_warn:false},
  {id:2,name:"Priya Sharma",role:"General Labourer",status:"on_site",site:"Harris Park Drainage",client:"Topline Constructions",app:"Active",cert_warn:false},
  {id:3,name:"Danny Nguyen",role:"Scaffolder · Civil Leading Hand",status:"on_site",site:"Chatswood Station",client:"Urban Build Co",app:"Active",cert_warn:false},
  {id:4,name:"Mia Thompson",role:"Skid Steer Operator",status:"on_site",site:"Liverpool Rd Upgrade",client:"FastTrack Civil",app:"Active",cert_warn:false},
  {id:5,name:"Luke Patel",role:"Formwork Carpenter · Steel Fixer",status:"job_details_sent",site:"Penrith Stadium Reno",client:"GroundUp Builders",app:"Active",cert_warn:true},
  {id:6,name:"Aaron Clarke",role:"Excavator Operator · Dozer",status:"available",site:null,client:null,app:"Profile Incomplete",cert_warn:false},
  {id:7,name:"Sophie Grant",role:"General Labourer",status:"available",site:null,client:null,app:"Invite Sent",cert_warn:false},
  {id:8,name:"Ben Okafor",role:"Concreter · RIW Worker",status:"available",site:null,client:null,app:"Completing Profile",cert_warn:false},
  {id:9,name:"Zoe Marchetti",role:"Roller Operator · Grader",status:"available",site:null,client:null,app:"Active",cert_warn:false},
  {id:10,name:"Kai Fitzpatrick",role:"Hirail Operator · Steel Fixer",status:"available",site:null,client:null,app:"Active",cert_warn:false},
];
const INIT_TS=[
  {id:1,worker:"James Holloway",client:"BuildRight Pty Ltd",site:"Southern Cross Tower",date:"Yesterday",reg:8.5,ot:1.5,client_ok:false,status:"pending"},
  {id:2,worker:"Priya Sharma",client:"Topline Constructions",site:"Harris Park Drainage",date:"Yesterday",reg:8.0,ot:0,client_ok:true,status:"pending"},
  {id:3,worker:"Danny Nguyen",client:"Urban Build Co",site:"Chatswood Station",date:"Yesterday",reg:7.5,ot:0,client_ok:false,status:"pending"},
];
const CLIENTS=[
  {id:"CL-001",name:"BuildRight Pty Ltd",site:"Southern Cross Tower",contact:"Mike Chen",rate:"$68.00"},
  {id:"CL-002",name:"Topline Constructions",site:"Harris Park Drainage",contact:"Sarah Blake",rate:"$58.00"},
  {id:"CL-003",name:"Urban Build Co",site:"Chatswood Station",contact:"Tom Reid",rate:"$75.00"},
  {id:"CL-004",name:"FastTrack Civil",site:"Liverpool Rd Upgrade",contact:"Jason Fox",rate:"$65.00"},
  {id:"CL-005",name:"GroundUp Builders",site:"Penrith Stadium Reno",contact:"Chris Wu",rate:"$78.00"},
];
const CERTS=[
  {worker:"Luke Patel",cert:"EWP Operator Certificate",expiry:"2024-04-01",days:-380},
  {worker:"James Holloway",cert:"EWP Operator Certificate",expiry:"2025-06-30",days:76},
  {worker:"Danny Nguyen",cert:"Working at Heights",expiry:"2025-08-15",days:122},
  {worker:"Kai Fitzpatrick",cert:"RIW Card",expiry:"2025-12-01",days:230},
];

const Pill=({label,color})=>{
  const m={gr:{bg:"rgba(34,197,94,.15)",tx:"#22c55e"},re:{bg:"rgba(239,68,68,.15)",tx:"#ef4444"},ye:{bg:"rgba(234,179,8,.15)",tx:"#eab308"},bl:{bg:"rgba(59,130,246,.15)",tx:"#3b82f6"},or:{bg:"rgba(249,115,22,.15)",tx:"#f97316"},gy:{bg:"rgba(139,144,168,.15)",tx:"#8b90a8"},cy:{bg:"rgba(6,182,212,.15)",tx:"#06b6d4"}};
  const s=m[color]||m.gy;
  return <span style={{background:s.bg,color:s.tx,padding:"2px 8px",borderRadius:20,fontSize:10,fontFamily:"monospace",fontWeight:600,whiteSpace:"nowrap",letterSpacing:.4}}>{label}</span>;
};
const Av=({name,sz=34})=>(
  <div style={{width:sz,height:sz,borderRadius:"50%",background:wColor(name),display:"flex",alignItems:"center",justifyContent:"center",fontSize:sz*.3,fontWeight:800,color:"#fff",flexShrink:0,fontFamily:"sans-serif"}}>{ini(name)}</div>
);
const Btn=({children,onClick,v="ghost",sm,style={}})=>{
  const m={ghost:{bg:"transparent",cl:C.t2,bd:`1px solid ${C.b1}`},primary:{bg:C.ac,cl:"#fff",bd:`1px solid ${C.ac}`},green:{bg:"rgba(34,197,94,.15)",cl:C.gr,bd:"1px solid rgba(34,197,94,.3)"},red:{bg:"rgba(239,68,68,.15)",cl:C.re,bd:"1px solid rgba(239,68,68,.3)"},blue:{bg:"rgba(59,130,246,.15)",cl:C.bl,bd:"1px solid rgba(59,130,246,.3)"}};
  const s=m[v]||m.ghost;
  return <button onClick={onClick} style={{background:s.bg,color:s.cl,border:s.bd,borderRadius:7,padding:sm?"3px 9px":"6px 13px",fontSize:sm?10:12,fontFamily:"sans-serif",fontWeight:700,cursor:"pointer",transition:"opacity .15s",...style}} onMouseEnter={e=>e.currentTarget.style.opacity=".75"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>{children}</button>;
};
const SC=({num,label,sub,color})=>(
  <div style={{background:C.s1,border:`1px solid ${C.b1}`,borderLeft:`3px solid ${color}`,borderRadius:11,padding:"16px 18px",flex:1,minWidth:0}}>
    <div style={{fontSize:26,fontWeight:800,color,fontFamily:"sans-serif",lineHeight:1}}>{num}</div>
    <div style={{fontSize:12,color:C.t1,fontWeight:700,marginTop:5,fontFamily:"sans-serif"}}>{label}</div>
    {sub&&<div style={{fontSize:10,color:C.t3,marginTop:2,fontFamily:"monospace"}}>{sub}</div>}
  </div>
);

const NAV=[
  {id:"dashboard",label:"Dashboard",icon:"▦",sec:"MAIN"},
  {id:"workers",label:"Workers",icon:"👷",sec:"MAIN"},
  {id:"allocations",label:"Allocations",icon:"📍",sec:"MAIN"},
  {id:"timesheets",label:"Timesheets",icon:"🕐",sec:"FINANCE"},
  {id:"clients",label:"Clients & Rates",icon:"🏗",sec:"FINANCE"},
  {id:"licences",label:"Licence Agent",icon:"📋",sec:"TOOLS"},
];

export default function App(){
  const [page,setPage]=useState("dashboard");
  const [ts,setTs]=useState(INIT_TS);
  const [wf,setWf]=useState("all");
  const [notif,setNotif]=useState({show:false,msg:""});
  const [sh,setSh]=useState(null);

  const showN=(msg)=>{setNotif({show:true,msg});setTimeout(()=>setNotif({show:false,msg:""}),3000);};
  const approveTS=(id)=>{setTs(t=>t.map(x=>x.id===id?{...x,status:"approved"}:x));showN("Timesheet approved → Xero ✓");};
  const rejectTS=(id)=>{setTs(t=>t.filter(x=>x.id!==id));showN("Timesheet rejected");};

  return(
    <>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0;}
        body{background:${C.bg};overflow:hidden;}
        ::-webkit-scrollbar{width:4px;height:4px;}
        ::-webkit-scrollbar-thumb{background:${C.b2};border-radius:2px;}
      `}</style>

      {/* Toast */}
      <div style={{position:"fixed",top:16,right:16,background:C.gr,color:"#fff",padding:"9px 16px",borderRadius:8,fontFamily:"sans-serif",fontSize:12,fontWeight:700,zIndex:9999,transform:notif.show?"translateY(0)":"translateY(-70px)",opacity:notif.show?1:0,transition:"all .3s ease",pointerEvents:"none",boxShadow:"0 4px 20px rgba(34,197,94,.45)"}}>✓ {notif.msg}</div>

      <div style={{display:"flex",height:"100vh",background:C.bg,fontFamily:"sans-serif",overflow:"hidden"}}>

        {/* Sidebar */}
        <div style={{width:210,background:C.s1,borderRight:`1px solid ${C.b1}`,display:"flex",flexDirection:"column",flexShrink:0}}>
          <div style={{padding:"20px 18px 16px",borderBottom:`1px solid ${C.b1}`}}>
            <div style={{fontSize:22,fontWeight:900,color:C.ac,letterSpacing:-1,fontFamily:"sans-serif"}}>CBD</div>
            <div style={{fontSize:9,color:C.t3,letterSpacing:2,marginTop:2,fontFamily:"monospace"}}>OPERATIONS PORTAL</div>
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"10px 0"}}>
            {["MAIN","FINANCE","TOOLS"].map(sec=>(
              <div key={sec} style={{marginBottom:6}}>
                <div style={{padding:"4px 18px 5px",fontSize:9,color:C.t3,letterSpacing:2,fontFamily:"monospace"}}>{sec}</div>
                {NAV.filter(n=>n.sec===sec).map(n=>{
                  const act=page===n.id;
                  return(
                    <div key={n.id} onClick={()=>setPage(n.id)} onMouseEnter={()=>setSh(n.id)} onMouseLeave={()=>setSh(null)}
                      style={{display:"flex",alignItems:"center",gap:9,padding:"8px 18px",cursor:"pointer",borderLeft:act?`2px solid ${C.ac}`:"2px solid transparent",background:act?"rgba(249,115,22,.1)":sh===n.id?"rgba(255,255,255,.03)":"transparent",transition:"all .12s"}}>
                      <span style={{fontSize:13}}>{n.icon}</span>
                      <span style={{fontSize:13,fontWeight:700,color:act?C.ac:C.t2}}>{n.label}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div style={{padding:"12px 18px",borderTop:`1px solid ${C.b1}`}}>
            <div style={{fontSize:9,color:C.t3,fontFamily:"monospace",marginBottom:4}}>ABN 75 663 693 070</div>
            <div style={{fontSize:9,color:C.t3,fontFamily:"monospace"}}>ROAD · RAIL · WATER</div>
          </div>
        </div>

        {/* Main */}
        <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0}}>
          {/* Topbar */}
          <div style={{padding:"15px 24px",borderBottom:`1px solid ${C.b1}`,display:"flex",alignItems:"center",justifyContent:"space-between",background:C.s1,flexShrink:0}}>
            <div style={{fontSize:16,fontWeight:800,color:C.t1}}>
              {NAV.find(n=>n.id===page)?.icon} {NAV.find(n=>n.id===page)?.label}
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn onClick={()=>showN("Blast sent to all 10 workers!")}>📢 Send Blast</Btn>
              <Btn v="primary" onClick={()=>showN("Worker invite sent!")}>+ Add Worker</Btn>
            </div>
          </div>

          {/* Content */}
          <div style={{flex:1,overflowY:"auto",padding:"22px 24px"}}>
            {page==="dashboard"&&<Dash ts={ts} approveTS={approveTS} rejectTS={rejectTS} setPage={setPage} showN={showN}/>}
            {page==="workers"&&<Workers wf={wf} setWf={setWf} showN={showN}/>}
            {page==="allocations"&&<Allocs/>}
            {page==="timesheets"&&<Sheets ts={ts} approveTS={approveTS} rejectTS={rejectTS}/>}
            {page==="clients"&&<Clients showN={showN}/>}
            {page==="licences"&&<Licences showN={showN}/>}
          </div>
        </div>
      </div>
    </>
  );
}

function Dash({ts,approveTS,rejectTS,setPage,showN}){
  const pend=ts.filter(t=>t.status==="pending");
  return(
    <div style={{display:"flex",flexDirection:"column",gap:18}}>
      <div style={{display:"flex",gap:12}}>
        <SC num="5" label="Workers On Site" sub="Active now" color={C.gr}/>
        <SC num="5" label="Available Pool" sub="Ready to allocate" color={C.bl}/>
        <SC num={pend.length} label="Pending Timesheets" sub="Awaiting approval" color={C.ye}/>
        <SC num="5" label="Client Approvals" sub="24h window" color={C.ac}/>
      </div>

      {/* Alert */}
      <div style={{background:"rgba(239,68,68,.07)",border:"1px solid rgba(239,68,68,.3)",borderRadius:11,padding:"14px 16px"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
          <span>🚨</span><span style={{fontWeight:700,color:C.re,fontSize:13}}>Urgent Alerts</span><Pill label="1 ACTION REQUIRED" color="re"/>
        </div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:C.s2,borderRadius:8,padding:"10px 14px"}}>
          <div>
            <span style={{fontSize:12,fontWeight:700,color:C.t1}}>Luke Patel</span>
            <span style={{fontSize:11,color:C.t3,marginLeft:8,fontFamily:"monospace"}}> EWP Certificate expired — cannot deploy until renewed</span>
          </div>
          <div style={{display:"flex",gap:6}}>
            <Btn sm v="green" onClick={()=>showN("Renewal reminder sent to Luke!")}>Notify</Btn>
            <Btn sm onClick={()=>{}}>Dismiss</Btn>
          </div>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        {/* Pending timesheets */}
        <div style={{background:C.s1,border:`1px solid ${C.b1}`,borderRadius:11,padding:16}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <span style={{fontWeight:700,color:C.t1,fontSize:13}}>Pending Timesheets</span>
            <Btn sm onClick={()=>setPage("timesheets")}>View All</Btn>
          </div>
          {pend.length===0?(
            <div style={{color:C.t3,fontSize:12,textAlign:"center",padding:"24px 0",fontStyle:"italic"}}>All timesheets approved ✓</div>
          ):(
            <div style={{display:"flex",flexDirection:"column",gap:7}}>
              {pend.map(t=>(
                <div key={t.id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",background:C.s2,borderRadius:8}}>
                  <Av name={t.worker} sz={30}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:12,fontWeight:700,color:C.t1}}>{t.worker}</div>
                    <div style={{fontSize:10,color:C.t3,fontFamily:"monospace"}}>{t.client}</div>
                  </div>
                  <div style={{fontWeight:800,color:C.ye,fontSize:15,minWidth:38,textAlign:"right"}}>{t.reg+t.ot}h</div>
                  {t.client_ok&&<Pill label="CLIENT ✓" color="gr"/>}
                  <Btn sm v="green" onClick={()=>approveTS(t.id)}>✓</Btn>
                  <Btn sm v="red" onClick={()=>rejectTS(t.id)}>✕</Btn>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Today's deployments */}
        <div style={{background:C.s1,border:`1px solid ${C.b1}`,borderRadius:11,padding:16}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <span style={{fontWeight:700,color:C.t1,fontSize:13}}>Today's Deployments</span>
            <Btn sm onClick={()=>setPage("allocations")}>Manage</Btn>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:7}}>
            {WORKERS.filter(w=>w.status==="on_site").map(w=>(
              <div key={w.id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",background:C.s2,borderRadius:8}}>
                <Av name={w.name} sz={30}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:700,color:C.t1}}>{w.name}</div>
                  <div style={{fontSize:10,color:C.t3,fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{w.site}</div>
                </div>
                <Pill label="ON SITE" color="gr"/>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Workers({wf,setWf,showN}){
  const ac=(s)=>s==="Active"?"gr":s==="Invite Sent"?"bl":s==="Completing Profile"?"cy":s==="Profile Incomplete"?"ye":"gy";
  const fw=wf==="all"?WORKERS:WORKERS.filter(w=>w.status===wf);
  return(
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        {[["all","All"],["on_site","On Site"],["available","Available"]].map(([v,l])=>(
          <button key={v} onClick={()=>setWf(v)} style={{padding:"5px 13px",borderRadius:7,border:`1px solid ${wf===v?C.ac:C.b1}`,background:wf===v?"rgba(249,115,22,.12)":"transparent",color:wf===v?C.ac:C.t2,fontSize:12,fontWeight:700,cursor:"pointer"}}>{l}</button>
        ))}
        <div style={{flex:1}}/>
        <Btn v="primary" onClick={()=>showN("Invite sent!")}>+ Add Worker</Btn>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:11}}>
        {fw.map(w=>(
          <div key={w.id} style={{background:C.s1,border:`1px solid ${w.cert_warn?"rgba(239,68,68,.4)":C.b1}`,borderRadius:11,padding:15,cursor:"pointer",transition:"border-color .15s"}}
            onMouseEnter={e=>e.currentTarget.style.borderColor=C.ac} onMouseLeave={e=>e.currentTarget.style.borderColor=w.cert_warn?"rgba(239,68,68,.4)":C.b1}>
            <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:9}}>
              <Av name={w.name} sz={36}/>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:C.t1}}>{w.name}</div>
                <div style={{fontSize:10,color:C.t3,fontFamily:"monospace"}}>{w.role.split("·")[0].trim()}</div>
              </div>
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:9}}>
              <Pill label={w.status==="on_site"?"ON SITE":w.status==="job_details_sent"?"DETAILS SENT":"AVAILABLE"} color={w.status==="on_site"?"gr":w.status==="job_details_sent"?"ye":"bl"}/>
              <Pill label={w.app} color={ac(w.app)}/>
              {w.cert_warn&&<Pill label="CERT EXPIRED" color="re"/>}
            </div>
            {w.site&&<div style={{fontSize:11,color:C.t2,background:C.s2,borderRadius:6,padding:"5px 9px",marginBottom:9}}>📍 {w.site}</div>}
            <div style={{display:"flex",gap:6}}>
              <Btn sm onClick={()=>showN(`Message sent to ${w.name.split(" ")[0]}!`)}>Message</Btn>
              <Btn sm v="primary" onClick={()=>showN(`${w.name.split(" ")[0]} allocated!`)}>Allocate</Btn>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Allocs(){
  const cols=[
    {id:"available",label:"Available Pool",color:C.bl,workers:WORKERS.filter(w=>w.status==="available")},
    {id:"job_details_sent",label:"Job Details Sent",color:C.ye,workers:WORKERS.filter(w=>w.status==="job_details_sent")},
    {id:"on_site",label:"On Site",color:C.gr,workers:WORKERS.filter(w=>w.status==="on_site")},
  ];
  return(
    <div style={{display:"flex",gap:14,height:"calc(100vh - 160px)"}}>
      {cols.map(col=>(
        <div key={col.id} style={{flex:1,display:"flex",flexDirection:"column",gap:9,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 13px",background:C.s1,borderRadius:9,border:`1px solid ${col.color}40`,flexShrink:0}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:col.color}}/>
            <span style={{fontWeight:700,color:col.color,fontSize:13}}>{col.label}</span>
            <span style={{marginLeft:"auto",background:`${col.color}22`,color:col.color,borderRadius:20,padding:"1px 8px",fontSize:11,fontFamily:"monospace"}}>{col.workers.length}</span>
          </div>
          <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:8}}>
            {col.workers.map(w=>(
              <div key={w.id} style={{background:C.s1,border:`1px solid ${C.b1}`,borderRadius:9,padding:"12px 13px"}}>
                <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:7}}>
                  <Av name={w.name} sz={30}/>
                  <div>
                    <div style={{fontSize:12,fontWeight:700,color:C.t1}}>{w.name}</div>
                    <div style={{fontSize:9,color:C.t3,fontFamily:"monospace"}}>{w.role.split("·")[0].trim()}</div>
                  </div>
                </div>
                {w.site?<div style={{fontSize:10,color:C.t2}}>📍 {w.site}</div>:<div style={{fontSize:10,color:C.t3,fontStyle:"italic"}}>No active allocation</div>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Sheets({ts,approveTS,rejectTS}){
  const pend=ts.filter(t=>t.status==="pending");
  const appr=ts.filter(t=>t.status==="approved");
  const static_appr=[
    {id:99,worker:"Mia Thompson",client:"FastTrack Civil",site:"Liverpool Rd",date:"2 days ago",reg:8,ot:0},
    {id:98,worker:"Luke Patel",client:"GroundUp Builders",site:"Penrith Stadium",date:"2 days ago",reg:9,ot:1},
  ];
  return(
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
      <div style={{background:C.s1,border:`1px solid ${C.b1}`,borderRadius:11,padding:16}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
          <span style={{fontWeight:700,color:C.t1,fontSize:13}}>Pending Approval</span>
          <Pill label={`${pend.length} PENDING`} color="ye"/>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {pend.length===0&&<div style={{color:C.t3,fontSize:12,textAlign:"center",padding:"28px 0",fontStyle:"italic"}}>All timesheets approved ✓</div>}
          {pend.map(t=>(
            <div key={t.id} style={{background:C.s2,borderRadius:8,padding:"11px 13px"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <Av name={t.worker} sz={28}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:700,color:C.t1}}>{t.worker}</div>
                  <div style={{fontSize:10,color:C.t3,fontFamily:"monospace"}}>{t.client}</div>
                </div>
                <div style={{fontWeight:800,color:C.ye,fontSize:15}}>{t.reg+t.ot}h</div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:10,color:C.t3,flex:1,fontFamily:"monospace"}}>{t.site} · {t.date}</span>
                {t.client_ok&&<Pill label="CLIENT ✓" color="gr"/>}
                <Btn sm v="green" onClick={()=>approveTS(t.id)}>✓ Approve</Btn>
                <Btn sm v="red" onClick={()=>rejectTS(t.id)}>✕</Btn>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{background:C.s1,border:`1px solid ${C.b1}`,borderRadius:11,padding:16}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
          <span style={{fontWeight:700,color:C.t1,fontSize:13}}>Approved — Xero Synced</span>
          <Pill label="⚡ XERO LIVE" color="bl"/>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {[...appr,...static_appr].map(t=>(
            <div key={t.id} style={{background:C.s2,borderRadius:8,padding:"11px 13px",display:"flex",alignItems:"center",gap:10}}>
              <Av name={t.worker} sz={28}/>
              <div style={{flex:1}}>
                <div style={{fontSize:12,fontWeight:700,color:C.t1}}>{t.worker}</div>
                <div style={{fontSize:10,color:C.t3,fontFamily:"monospace"}}>{t.site} · {t.date}</div>
              </div>
              <div style={{fontWeight:800,color:C.gr,fontSize:14}}>{(t.reg||0)+(t.ot||0)}h</div>
              <Pill label="XERO ✓" color="gr"/>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Clients({showN}){
  return(
    <div style={{background:C.s1,border:`1px solid ${C.b1}`,borderRadius:11,overflow:"hidden"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 18px",borderBottom:`1px solid ${C.b1}`}}>
        <span style={{fontWeight:700,color:C.t1,fontSize:13}}>Active Clients</span>
        <Btn v="primary" onClick={()=>showN("New client added!")}>+ New Client</Btn>
      </div>
      <table style={{width:"100%",borderCollapse:"collapse"}}>
        <thead>
          <tr style={{background:C.s2}}>
            {["ID","Client","Site","Contact","Rate /hr","OT",""].map(h=>(
              <th key={h} style={{padding:"9px 14px",textAlign:"left",fontSize:9,fontFamily:"monospace",color:C.t3,letterSpacing:1,fontWeight:400}}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CLIENTS.map((c,i)=>(
            <tr key={c.id} style={{background:i%2===0?C.s1:C.s2,borderTop:`1px solid ${C.b1}`}}>
              <td style={{padding:"11px 14px",fontSize:10,fontFamily:"monospace",color:C.t3}}>{c.id}</td>
              <td style={{padding:"11px 14px",fontSize:13,fontWeight:700,color:C.t1}}>{c.name}</td>
              <td style={{padding:"11px 14px",fontSize:12,color:C.t2}}>{c.site}</td>
              <td style={{padding:"11px 14px",fontSize:12,color:C.t2}}>{c.contact}</td>
              <td style={{padding:"11px 14px",fontWeight:800,color:C.ac,fontSize:14}}>{c.rate}</td>
              <td style={{padding:"11px 14px"}}><Pill label="1.5×" color="or"/></td>
              <td style={{padding:"11px 14px"}}>
                <div style={{display:"flex",gap:5}}>
                  <Btn sm onClick={()=>showN("Invoice sent!")}>Invoice</Btn>
                  <Btn sm v="blue" onClick={()=>showN("Approval link sent!")}>Approval Link</Btn>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Licences({showN}){
  return(
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div style={{background:C.s1,border:`1px solid ${C.b1}`,borderRadius:11,padding:"14px 18px",display:"flex",alignItems:"center",gap:12}}>
        <span style={{fontSize:20}}>🔍</span>
        <div>
          <div style={{fontWeight:700,color:C.t1,fontSize:13}}>Licence & Certification Agent</div>
          <div style={{fontSize:10,color:C.t3,fontFamily:"monospace"}}>Automated weekly scan · Every Monday 7:30 AM AEST</div>
        </div>
        <div style={{marginLeft:"auto"}}>
          <Btn v="primary" onClick={()=>showN("Full compliance scan complete! 1 expired, 2 expiring soon.")}>🔄 Run Full Scan</Btn>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
        {CERTS.map((c,i)=>{
          const exp=c.days<0;const warn=c.days>=0&&c.days<90;
          const pc=exp?"re":warn?"ye":"gr";
          return(
            <div key={i} style={{background:C.s1,border:`1px solid ${exp?"rgba(239,68,68,.4)":warn?"rgba(234,179,8,.3)":C.b1}`,borderRadius:11,padding:15}}>
              <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:10}}>
                <Av name={c.worker} sz={34}/>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:C.t1}}>{c.worker}</div>
                  <div style={{fontSize:10,color:C.t3,fontFamily:"monospace"}}>{c.cert}</div>
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:C.s2,borderRadius:7,padding:"7px 11px",marginBottom:10}}>
                <span style={{fontSize:11,color:C.t2}}>Expires {c.expiry}</span>
                <Pill label={exp?"EXPIRED":`${c.days}d LEFT`} color={pc}/>
              </div>
              {(exp||warn)&&(
                <Btn sm v={exp?"red":"ghost"} style={{width:"100%"}} onClick={()=>showN(`Renewal reminder sent to ${c.worker.split(" ")[0]}!`)}>
                  {exp?"🚨 Send Urgent Renewal":"⚠️ Send Expiry Reminder"}
                </Btn>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
