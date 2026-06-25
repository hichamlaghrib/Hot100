import sys
import json
import pandas as pd
import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from datetime import timedelta

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

def main():
    input_data = json.load(sys.stdin)
    creators_data = input_data.get('creators', [])
    horizon_days = input_data.get('horizon_days', 84)
    
    if not creators_data:
        print(json.dumps({}))
        return

    records = []
    for c in creators_data:
        cid = c['creatorId']
        genre = c.get('genre', 'Unknown')
        for h in c['history']:
            records.append({
                'creatorId': cid,
                'genre': genre,
                'date': h['date'],
                'views': h.get('views', 0),
                'followers': h.get('followers', 0),
                'uploads': h.get('uploads', 0),
                'engagements': h.get('engagements', 0)
            })
            
    df = pd.DataFrame(records)
    if df.empty:
        print(json.dumps({}))
        return

    df['date'] = pd.to_datetime(df['date'])
    df['genre'] = df['genre'].astype('category')
    df = create_features(df)
    
    # ── Holdout Evaluation (last 28 days) ──
    max_date = df['date'].max()
    split_date = max_date - pd.Timedelta(days=28)
    
    train_split = df[df['date'] <= split_date].dropna().copy()
    test_split = df[df['date'] > split_date].dropna().copy()
    
    features = [c for c in df.columns if c not in ['creatorId', 'date', 'views', 'followers', 'genre']]
    # Note: HistGradientBoosting supports categorical but needs numerical encoding or specific setup.
    # We will just drop 'genre' for simplicity to avoid encoding issues.
    
    eval_metrics = {}
    
    if not train_split.empty and not test_split.empty:
        m_v = HistGradientBoostingRegressor(loss='squared_error', max_iter=50, random_state=42)
        m_v.fit(train_split[features], train_split['views'])
        
        m_f = HistGradientBoostingRegressor(loss='squared_error', max_iter=50, random_state=42)
        m_f.fit(train_split[features], train_split['followers'])
        
        test_split['pred_views'] = m_v.predict(test_split[features])
        test_split['pred_followers'] = m_f.predict(test_split[features])
        
        for cid, group in test_split.groupby('creatorId'):
            sum_v_a = group['views'].sum()
            sum_v_p = group['pred_views'].sum()
            err_v = abs(sum_v_a - sum_v_p) / (sum_v_a + 1e-8) * 100
            
            sum_f_a = group['followers'].sum()
            sum_f_p = group['pred_followers'].sum()
            err_f = abs(sum_f_a - sum_f_p) / (abs(sum_f_a) + 1e-8) * 100
            
            eval_metrics[cid] = {
                'views': { 'cvMape': err_v, 'testMape': err_v },
                'followers': { 'cvMape': err_f, 'testMape': err_f }
            }

    # ── Final Training (Quantiles) ──
    train_df = df.dropna().copy()
    if train_df.empty:
        print(json.dumps({}))
        return

    X = train_df[features]
    y_views = train_df['views']
    y_followers = train_df['followers']

    models_views = {}
    models_followers = {}
    alphas = [0.1, 0.5, 0.9]
    
    for alpha in alphas:
        mv = HistGradientBoostingRegressor(loss='quantile', quantile=alpha, max_iter=100, random_state=42)
        mv.fit(X, y_views)
        models_views[alpha] = mv
        
        mf = HistGradientBoostingRegressor(loss='quantile', quantile=alpha, max_iter=100, random_state=42)
        mf.fit(X, y_followers)
        models_followers[alpha] = mf
        
    latest_rows = df.sort_values('date').groupby('creatorId').last().reset_index()
    active_creators = latest_rows['creatorId'].unique()
    
    views_preds = {cid: {0.1: [], 0.5: [], 0.9: []} for cid in active_creators}
    followers_preds = {cid: {0.1: [], 0.5: [], 0.9: []} for cid in active_creators}
    
    last_30_df = df.sort_values(['creatorId', 'date']).groupby('creatorId').tail(35).copy()
    max_date = latest_rows['date'].max()
    future_dates = [max_date + timedelta(days=i) for i in range(1, horizon_days + 1)]
    
    for d in future_dates:
        new_rows = []
        for _, row in latest_rows.iterrows():
            new_rows.append({
                'creatorId': row['creatorId'], 'date': d, 'genre': row['genre'],
                'views': 0, 'followers': 0, 'uploads': 0, 'engagements': 0
            })
        new_df = pd.DataFrame(new_rows)
        new_df['genre'] = new_df['genre'].astype('category')
        
        last_30_df = pd.concat([last_30_df, new_df], ignore_index=True)
        last_30_df = last_30_df.sort_values(['creatorId', 'date']).groupby('creatorId').tail(35)
        
        curr_feats = create_features(last_30_df)
        d_feats = curr_feats[curr_feats['date'] == d].copy()
        
        for alpha in alphas:
            v_p = models_views[alpha].predict(d_feats[features])
            f_p = models_followers[alpha].predict(d_feats[features])
            
            for i, cid in enumerate(d_feats['creatorId']):
                views_preds[cid][alpha].append(max(0, float(v_p[i])))
                followers_preds[cid][alpha].append(float(f_p[i]))
                
                if alpha == 0.5:
                    idx = last_30_df[(last_30_df['creatorId'] == cid) & (last_30_df['date'] == d)].index[0]
                    last_30_df.at[idx, 'views'] = max(0, float(v_p[i]))
                    last_30_df.at[idx, 'followers'] = float(f_p[i])

    results = {}
    for cid in active_creators:
        results[cid] = {
            'views': { 'p10': views_preds[cid][0.1], 'p50': views_preds[cid][0.5], 'p90': views_preds[cid][0.9] },
            'followers': { 'p10': followers_preds[cid][0.1], 'p50': followers_preds[cid][0.5], 'p90': followers_preds[cid][0.9] },
            'dates': [d.strftime('%Y-%m-%d') for d in future_dates],
            'metrics': eval_metrics.get(cid, {'views': {'cvMape': 999, 'testMape': 999}, 'followers': {'cvMape': 999, 'testMape': 999}})
        }
        
    print(json.dumps(results))

if __name__ == "__main__":
    main()
