// VRoid Studio の .vroidpose に必須の VRoidCustomData の雛形。
// VRoid Studio で保存した初期ポーズ(A-Stance)のファイルから、Unity の付属プロパティ
// (normalized / magnitude / sqrMagnitude / eulerAngles)を除いて作成したもの(除いても読み込めることを確認済み)。
// VRoid Studio はポーズを BoneDefinition ではなく、主に Positions(腰基準の各ボーン位置)と
// PoseGizmoDefinitions の Direction から復元する。これらは exportVroidPose() が書き出し時に計算して上書きする。
// PoseGizmoDefinitions[].Value は書き出し時に JSON 文字列化する(VRoid の形式)。
export const VROIDPOSE_CUSTOM_TEMPLATE = {
 "PresetPose": "A-Stance",
 "HipPositionDelta": {
  "x": 0.0,
  "y": 0.0,
  "z": 0.0
 },
 "Types": [
  10,
  9,
  0,
  7,
  8,
  54,
  11,
  13,
  15,
  17,
  12,
  14,
  16,
  18,
  1,
  3,
  5,
  19,
  2,
  4,
  6,
  20
 ],
 "Positions": [],
 "SpineControlPointDiff": {
  "x": 1.26601662e-09,
  "y": 0.0,
  "z": -5.58793545e-09
 },
 "PoseGizmoDefinitions": [
  {
   "Type": 5,
   "Key": "Head Roll",
   "Value": {
    "Direction": {
     "x": -3.425356e-07,
     "y": 0.99971205,
     "z": 0.0239957366
    },
    "Name": "Head Roll"
   }
  },
  {
   "Type": 5,
   "Key": "Head LookAt",
   "Value": {
    "Direction": {
     "x": -7.92608944e-07,
     "y": -0.0108990259,
     "z": 0.9999406
    },
    "Name": "Head LookAt"
   }
  },
  {
   "Type": 5,
   "Key": "LeftHandLookAtControlPoint",
   "Value": {
    "Direction": {
     "x": -0.7369746,
     "y": -0.645811558,
     "z": 0.199489117
    },
    "Name": "LeftHandLookAtControlPoint"
   }
  },
  {
   "Type": 5,
   "Key": "RightHandLookAtControlPoint",
   "Value": {
    "Direction": {
     "x": 0.7369784,
     "y": -0.64580965,
     "z": 0.19948107
    },
    "Name": "RightHandLookAtControlPoint"
   }
  },
  {
   "Type": 5,
   "Key": "LeftFootLookAtControlPoint",
   "Value": {
    "Direction": {
     "x": 0.0991394743,
     "y": -0.006113963,
     "z": 0.9950547
    },
    "Name": "LeftFootLookAtControlPoint"
   }
  },
  {
   "Type": 5,
   "Key": "LeftFootFootRollControlPoint",
   "Value": {
    "Direction": {
     "x": 0.05104967,
     "y": -0.996077955,
     "z": -0.07226822
    },
    "Name": "LeftFootFootRollControlPoint"
   }
  },
  {
   "Type": 5,
   "Key": "RightFootLookAtControlPoint",
   "Value": {
    "Direction": {
     "x": -0.09913957,
     "y": -0.00611396274,
     "z": 0.9950547
    },
    "Name": "RightFootLookAtControlPoint"
   }
  },
  {
   "Type": 5,
   "Key": "RightFootFootRollControlPoint",
   "Value": {
    "Direction": {
     "x": -0.05104993,
     "y": -0.996077955,
     "z": -0.07226824
    },
    "Name": "RightFootFootRollControlPoint"
   }
  },
  {
   "Type": 6,
   "Key": "LeftHandrollControlHandle",
   "Value": {
    "LimitMax180Angle": 180.0,
    "LimitMin180Angle": -180.0,
    "Name": "LeftHandrollControlHandle",
    "startAngle": 0.0,
    "start180Angle": 0.0,
    "Current180Angle": 0.0
   }
  },
  {
   "Type": 6,
   "Key": "RightHandrollControlHandle",
   "Value": {
    "LimitMax180Angle": 180.0,
    "LimitMin180Angle": -180.0,
    "Name": "RightHandrollControlHandle",
    "startAngle": 0.0,
    "start180Angle": 0.0,
    "Current180Angle": 0.0
   }
  },
  {
   "Type": 2,
   "Key": "FullBodyCenter",
   "Value": {
    "Name": "FullBodyCenter",
    "InitialBodyPosition": {
     "x": 0.00112124509,
     "y": 0.710317552,
     "z": 0.00115234347
    },
    "CurrentBodyPosition": {
     "x": 0.00112124509,
     "y": 0.710317552,
     "z": 0.00115234347
    }
   }
  },
  {
   "Type": 1,
   "Key": "LeftHandTarget",
   "Value": {
    "Name": "LeftHandTarget",
    "InitialLocalPosition": {
     "x": -0.36814,
     "y": 0.7626,
     "z": 0.03606
    },
    "CurrentLocalPosition": {
     "x": -0.368136525,
     "y": 0.7625973,
     "z": 0.0360596031
    }
   }
  },
  {
   "Type": 1,
   "Key": "RightHandTarget",
   "Value": {
    "Name": "RightHandTarget",
    "InitialLocalPosition": {
     "x": 0.36774,
     "y": 0.7626,
     "z": 0.03606
    },
    "CurrentLocalPosition": {
     "x": 0.367739946,
     "y": 0.762598038,
     "z": 0.03605909
    }
   }
  },
  {
   "Type": 1,
   "Key": "LeftFootTarget",
   "Value": {
    "Name": "LeftFootTarget",
    "InitialLocalPosition": {
     "x": -0.11908,
     "y": 0.09289,
     "z": -0.01714
    },
    "CurrentLocalPosition": {
     "x": -0.119083904,
     "y": 0.09289104,
     "z": -0.01713923
    }
   }
  },
  {
   "Type": 1,
   "Key": "RightFootTarget",
   "Value": {
    "Name": "RightFootTarget",
    "InitialLocalPosition": {
     "x": 0.11869,
     "y": 0.09289,
     "z": -0.01714
    },
    "CurrentLocalPosition": {
     "x": 0.11868652,
     "y": 0.09289104,
     "z": -0.0171392374
    }
   }
  },
  {
   "Type": 0,
   "Key": "leftArmIK",
   "Value": {
    "Name": "leftArmIK",
    "CurrentShoulderRotation": {
     "x": 0.0,
     "y": 0.01835131,
     "z": 0.0,
     "w": 0.9998316
    },
    "CurrentLowerArmRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 1.0
    },
    "CurrentHandRotation": {
     "x": 3.07893015e-06,
     "y": -0.00128627929,
     "z": -0.00215511071,
     "w": 0.999996841
    }
   }
  },
  {
   "Type": 0,
   "Key": "rightArmIK",
   "Value": {
    "Name": "rightArmIK",
    "CurrentShoulderRotation": {
     "x": 0.0,
     "y": -0.0183508135,
     "z": 0.0,
     "w": 0.9998316
    },
    "CurrentLowerArmRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 1.0
    },
    "CurrentHandRotation": {
     "x": 3.07869868e-06,
     "y": 0.00128616125,
     "z": 0.00215552677,
     "w": 0.999996841
    }
   }
  },
  {
   "Type": 4,
   "Key": "leftFootIK",
   "Value": {
    "Name": "leftFootIK",
    "CurrentFootRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.07212787,
     "w": 0.9973954
    },
    "CurrentUpperLegRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 1.0
    },
    "StartFootRotation": {
     "x": -0.0347227231,
     "y": 0.00259730569,
     "z": 0.07208713,
     "w": 0.9967904
    },
    "StartUpperLegRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 1.0
    },
    "RollControlPointLocalDir": {
     "x": 0.0,
     "y": -0.25,
     "z": 0.00204804074
    },
    "LookAtControlPointLocalDir": {
     "x": -1.77442694e-09,
     "y": 3.43264439e-08,
     "z": 0.2
    }
   }
  },
  {
   "Type": 4,
   "Key": "rightFootIK",
   "Value": {
    "Name": "rightFootIK",
    "CurrentFootRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.07212799,
     "w": -0.9973954
    },
    "CurrentUpperLegRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 1.0
    },
    "StartFootRotation": {
     "x": -0.0347227156,
     "y": -0.002597306,
     "z": -0.07208713,
     "w": 0.9967904
    },
    "StartUpperLegRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 1.0
    },
    "RollControlPointLocalDir": {
     "x": 0.0,
     "y": -0.25,
     "z": 0.00204804074
    },
    "LookAtControlPointLocalDir": {
     "x": -3.5531e-08,
     "y": 1.24719421e-07,
     "z": 0.199999988
    }
   }
  },
  {
   "Type": 3,
   "Key": "HeadIK",
   "Value": {
    "Name": "HeadIK",
    "CurrentRollRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 7.103516e-09,
     "w": 1.0
    }
   }
  },
  {
   "Type": 7,
   "Key": "UpperChestFK",
   "Value": {
    "Name": "UpperChestFK",
    "StartDir": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0
    },
    "StartRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 0.0
    },
    "CurrentRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 1.0
    }
   }
  },
  {
   "Type": 8,
   "Key": "UpperLegsFK",
   "Value": {
    "Name": "UpperLegsFK",
    "StartDir": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0
    },
    "StartRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 0.0
    },
    "CurrentRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 1.0
    }
   }
  },
  {
   "Type": 9,
   "Key": "ShouldersRotator",
   "Value": {
    "Name": "ShouldersRotator",
    "StartDir": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0
    },
    "StartRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 0.0
    },
    "CurrentRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 1.0
    }
   }
  },
  {
   "Type": 10,
   "Key": "TorsoRotator",
   "Value": {
    "Name": "TorsoRotator",
    "HipRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 1.0
    },
    "SpineRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 1.0
    },
    "ChestRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 1.0
    },
    "UpperChestRotation": {
     "x": 0.0,
     "y": 0.0,
     "z": 0.0,
     "w": 1.0
    }
   }
  }
 ]
};
