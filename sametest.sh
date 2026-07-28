#!/bin/bash
API=http://localhost:5173/api
tok() { curl -s -X POST $API/run | python -c "import sys,json;print(json.load(sys.stdin).get('token',''))"; }
post() { curl -s -X POST $API/scores -H "Content-Type: application/json" -d "$1"; }
A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa   # player A's browser
B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb   # player B's browser, same name
C=cccccccccccccccccccccccccccccccc
D=dddddddddddddddddddddddddddddddd
E=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee

T1=$(tok); T2=$(tok); T3=$(tok); T4=$(tok); T5=$(tok); T6=$(tok)
sleep 70

echo "1. Sam (player A) posts wave 5"
post "{\"token\":\"$T1\",\"client\":\"$A\",\"name\":\"Sam\",\"wave\":5,\"kills\":60,\"timeSurvived\":66}"
echo; echo "2. a DIFFERENT Sam (player B) posts a WORSE wave 3"
post "{\"token\":\"$T2\",\"client\":\"$B\",\"name\":\"Sam\",\"wave\":3,\"kills\":25,\"timeSurvived\":40}"
echo; echo "3. player A improves to wave 6 (should replace their own row only)"
post "{\"token\":\"$T3\",\"client\":\"$A\",\"name\":\"Sam\",\"wave\":6,\"kills\":80,\"timeSurvived\":68}"
echo; echo "4. a THIRD Sam"
post "{\"token\":\"$T4\",\"client\":\"$C\",\"name\":\"sam\",\"wave\":4,\"kills\":40,\"timeSurvived\":55}"
echo; echo "5. a FOURTH Sam (over the cap)"
post "{\"token\":\"$T5\",\"client\":\"$D\",\"name\":\"SAM\",\"wave\":4,\"kills\":42,\"timeSurvived\":56}"
echo; echo "6. someone with a different name is unaffected"
post "{\"token\":\"$T6\",\"client\":\"$E\",\"name\":\"Ana\",\"wave\":4,\"kills\":38,\"timeSurvived\":52}"
echo; echo "--- final board ---"
curl -s $API/scores | python -c "
import sys,json
for i,e in enumerate(json.load(sys.stdin)['entries'],1):
    print(f\"  {i}. {e['name']:<6} wave {e['wave']}  kills {e['kills']}\")"
