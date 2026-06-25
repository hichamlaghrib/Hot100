import pandas as pd
import numpy as np
from datetime import datetime, timedelta

def create_features(df):
    df = df.sort_values(['creatorId', 'date']).reset_index(drop=True)
    df['dayofweek'] = df['date'].dt.dayofweek
    df['month'] = df['date'].dt.month
    
    for lag in [1, 2, 7, 14]:
        df[f'views_lag_{lag}'] = df.groupby('creatorId')['views'].shift(lag)
        df[f'followers_lag_{lag}'] = df.groupby('creatorId')['followers'].shift(lag)
        df[f'uploads_lag_{lag}'] = df.groupby('creatorId')['uploads'].shift(lag)
        df[f'engagements_lag_{lag}'] = df.groupby('creatorId')['engagements'].shift(lag)
        
    df['views_roll_7'] = df.groupby('creatorId')['views_lag_1'].transform(lambda x: x.rolling(7, min_periods=1).mean())
    df['views_roll_30'] = df.groupby('creatorId')['views_lag_1'].transform(lambda x: x.rolling(30, min_periods=1).mean())
    return df

records = []
date_start = datetime(2023, 1, 1)
for c in range(100):
    for d in range(35):
        records.append({'creatorId': c, 'date': date_start + timedelta(days=d), 'views': d, 'followers': d, 'uploads': 0, 'engagements': 0})
df = pd.DataFrame(records)

import time
start = time.time()
for d in range(84):
    new_rows = [{'creatorId': c, 'date': date_start + timedelta(days=35+d), 'views': 0, 'followers': 0, 'uploads': 0, 'engagements': 0} for c in range(100)]
    df = pd.concat([df, pd.DataFrame(new_rows)], ignore_index=True)
    df = df.groupby('creatorId').tail(35)
    feats = create_features(df)
print("Time:", time.time() - start)
