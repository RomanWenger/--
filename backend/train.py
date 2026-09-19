"""
DQN 重训脚本：基于地形驱动危险场，state_dim=19

用法：python train.py [episodes]
"""
import os
import sys
import numpy as np
from environment import MountainRescueEnv, GRID_SIZE, STATE_DIM, ACTION_DIM
from model import DQNAgent

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, 'dqn_model.pth')


def train(episodes=1500):
    env = MountainRescueEnv(grid_size=GRID_SIZE, amplitude=1.0)
    agent = DQNAgent(STATE_DIM, ACTION_DIM, lr=1e-4, epsilon_decay=0.997)
    print(f"Training DQN: state_dim={STATE_DIM}, grid={GRID_SIZE}, episodes={episodes}")

    for ep in range(episodes):
        state = env.reset(wind_speed=0.5)
        done = False
        total_reward = 0.0
        steps = 0
        while not done and steps < 250:
            action = agent.select_action(state, training=True)
            next_state, reward, done, cost = env.step(action)
            agent.store_transition(state, action, reward, next_state, done)
            agent.update()
            state = next_state
            total_reward += reward
            steps += 1
        if ep % 100 == 0:
            eps = round(agent.epsilon, 3)
            print(f"ep {ep:4d} steps={steps:3d} reward={total_reward:8.1f} epsilon={eps}")

    agent.save(MODEL_PATH)
    print(f"Model saved to {MODEL_PATH}")


if __name__ == '__main__':
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1500
    train(n)
