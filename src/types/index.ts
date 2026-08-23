export type RouteKey = 'home' | 'signup' | 'login' | 'profile' | 'pricing';

export interface Doctor {
    id: string;
    name: string;
    specialty: string;
    contact: string;
    availability: string[];
}

export interface Patient {
    id: string;
    name: string;
    email: string;
    phone: string;
    registeredAt: Date;
}

export interface ServicePlan {
    id: string;
    name: string;
    description: string;
    fee: number;
}